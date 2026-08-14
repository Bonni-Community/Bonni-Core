import bcrypt from "bcryptjs";

import { prisma } from "../../../../core/database/prisma.js";
import {
  buildTotpOtpauthUri,
  buildTotpQrCodeDataUrl,
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  recoveryCodeHash,
  verifyTotpCode,
} from "./totp.js";
import type {
  ConfirmTotpInput,
  CreateChallengeInput,
  DisableTwoFactorInput,
  RegenerateRecoveryCodesInput,
  SetupTotpInput,
} from "../schemas/two-factor.schemas.js";
import {
  getActiveExternalTwoFactorProvider,
  getRegisteredExternalTwoFactorProviderById,
  type TwoFactorProof,
} from "../two-factor-provider-registry.js";

const db = prisma as any;

export type RequestMeta = {
  ip?: string;
  userAgent?: string;
};

export type TwoFactorPurpose =
  | "LOGIN"
  | "SECURITY_SETTINGS"
  | "ADMIN_ELEVATION"
  | "DSGVO_SUBJECT_DATA_VIEW"
  | "DSGVO_SUBJECT_DATA_EXPORT"
  | "DSGVO_SUBJECT_DATA_DELETE"
  | "DSGVO_DELETION_RULE_UPDATE"
  | "MODULE_PRIVATE_DATA_ACCESS";

type ActiveCredential = {
  id: string;
  accountId: string;
  method: "TOTP" | "RECOVERY_CODE" | "WEBAUTHN";
  label?: string | null;
  secretEncrypted?: string | null;
  status: string;
};

type CodeVerification = {
  ok: boolean;
  method: "TOTP" | "RECOVERY_CODE";
  credentialId?: string;
  provider: string;
};

function httpError(code: string, statusCode = 400, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { statusCode, code, details });
}

function addMinutes(minutes: number) {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

function addSeconds(seconds: number) {
  const date = new Date();
  date.setSeconds(date.getSeconds() + seconds);
  return date;
}

const LOCAL_TWO_FACTOR_MAX_ATTEMPTS = 3;
const LOCAL_CHALLENGE_EXPIRES_SECONDS = 10 * 60;
const TWO_FACTOR_BASE_LOCK_MINUTES = 3;
const TWO_FACTOR_MAX_LOCK_MINUTES = 24 * 60;
// Diese Markierung ist absichtlich dauerhaft. Sobald ein externer
// Zwei-Faktor-Anbieter einmal eingerichtet war, duerfen geschuetzte Daten
// durch das spaetere Deaktivieren oder Entfernen des Plugins niemals wieder
// ungeschuetzt lesbar werden. Es gibt deshalb keinen normalen Reset-Pfad.
const PRIVATE_DATA_PROTECTION_ENROLLED_EVENT =
  "TWO_FACTOR_PRIVATE_DATA_PROTECTION_ENROLLED";

const LOCAL_PROOF_FIELDS = Object.freeze([{
  name: "code" as const,
  label: "Authenticator-Code",
  type: "password" as const,
  autocomplete: "one-time-code" as const,
}]);

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
}

async function getProviderContext() {
  const external = await getActiveExternalTwoFactorProvider();
  if (external) {
    return {
      id: external.provider.id,
      label: external.provider.label,
      configured: external.state.configured,
      externallyManaged: true,
      details: external.state.details || {},
      policy: {
        maxAttempts: boundedInteger(external.state.policy.maxAttempts, 8, 1, 20),
        challengeExpiresSeconds: boundedInteger(
          external.state.policy.challengeExpiresSeconds,
          60,
          30,
          600,
        ),
        proofFields: external.state.policy.proofFields,
      },
    };
  }
  return {
    id: "local",
    label: "Authenticator-App (TOTP)",
    configured: true,
    externallyManaged: false,
    details: {},
    policy: {
      maxAttempts: LOCAL_TWO_FACTOR_MAX_ATTEMPTS,
      challengeExpiresSeconds: LOCAL_CHALLENGE_EXPIRES_SECONDS,
      proofFields: LOCAL_PROOF_FIELDS,
    },
  };
}


function scopeKey(purpose: TwoFactorPurpose | "TOTP_SETUP" | "SECURITY_SETTINGS") {
  return `2FA:${purpose}`;
}

function lockMinutesForLevel(lockLevel: number) {
  return Math.min(TWO_FACTOR_BASE_LOCK_MINUTES * 2 ** Math.max(lockLevel, 0), TWO_FACTOR_MAX_LOCK_MINUTES);
}

async function getLockout(accountId: string, scope: string) {
  return db.securityTwoFactorLockout?.findUnique?.({
    where: {
      accountId_scopeKey: {
        accountId,
        scopeKey: scope,
      },
    },
  });
}

function lockoutPayload(lockout: any, maxAttempts = LOCAL_TWO_FACTOR_MAX_ATTEMPTS) {
  return {
    lockedUntil: lockout?.lockedUntil,
    failedAttempts: lockout?.failedAttempts ?? 0,
    maxAttempts,
    lockLevel: lockout?.lockLevel ?? 0,
  };
}

async function assertNotLocked(
  accountId: string,
  scope: string,
  meta?: RequestMeta,
  purpose?: TwoFactorPurpose,
  maxAttempts = LOCAL_TWO_FACTOR_MAX_ATTEMPTS,
) {
  const lockout = await getLockout(accountId, scope);

  if (lockout?.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
    await writeAudit({
      accountId,
      event: "TWO_FACTOR_LOCKOUT_BLOCKED",
      purpose,
      result: "BLOCKED",
      meta,
      metadataJson: { scope, ...lockoutPayload(lockout, maxAttempts) },
    });

    throw httpError("TWO_FACTOR_TEMPORARILY_LOCKED", 423, lockoutPayload(lockout, maxAttempts));
  }
}

async function registerFailedAttempt(input: {
  accountId: string;
  scope: string;
  purpose?: TwoFactorPurpose;
  method?: "TOTP" | "RECOVERY_CODE" | "WEBAUTHN";
  meta?: RequestMeta;
  metadataJson?: unknown;
  maxAttempts?: number;
}) {
  const maxAttempts = boundedInteger(
    input.maxAttempts,
    LOCAL_TWO_FACTOR_MAX_ATTEMPTS,
    1,
    20,
  );
  const existing = await getLockout(input.accountId, input.scope);
  const failedAttempts = (existing?.failedAttempts ?? 0) + 1;

  if (failedAttempts < maxAttempts) {
    const lockout = await db.securityTwoFactorLockout.upsert({
      where: {
        accountId_scopeKey: {
          accountId: input.accountId,
          scopeKey: input.scope,
        },
      },
      create: {
        accountId: input.accountId,
        scopeKey: input.scope,
        failedAttempts,
        lockLevel: existing?.lockLevel ?? 0,
        lastFailureAt: new Date(),
        metadataJson: input.metadataJson,
      },
      update: {
        failedAttempts,
        lastFailureAt: new Date(),
        metadataJson: input.metadataJson,
      },
    });

    return { locked: false, ...lockoutPayload(lockout, maxAttempts) };
  }

  const lockLevel = existing?.lockLevel ?? 0;
  const lockMinutes = lockMinutesForLevel(lockLevel);
  const lockedUntil = addMinutes(lockMinutes);

  const lockout = await db.securityTwoFactorLockout.upsert({
    where: {
      accountId_scopeKey: {
        accountId: input.accountId,
        scopeKey: input.scope,
      },
    },
    create: {
      accountId: input.accountId,
      scopeKey: input.scope,
      failedAttempts: 0,
      lockLevel: lockLevel + 1,
      lockedUntil,
      lastFailureAt: new Date(),
      metadataJson: input.metadataJson,
    },
    update: {
      failedAttempts: 0,
      lockLevel: lockLevel + 1,
      lockedUntil,
      lastFailureAt: new Date(),
      metadataJson: input.metadataJson,
    },
  });

  await writeAudit({
    accountId: input.accountId,
    event: "TWO_FACTOR_TEMPORARILY_LOCKED",
    purpose: input.purpose,
    method: input.method,
    result: "BLOCKED",
    meta: input.meta,
    metadataJson: {
      scope: input.scope,
      lockMinutes,
      ...lockoutPayload(lockout, maxAttempts),
    },
  });

  return { locked: true, lockMinutes, ...lockoutPayload(lockout, maxAttempts) };
}

async function registerSuccessfulAttempt(accountId: string, scope: string) {
  await db.securityTwoFactorLockout?.upsert?.({
    where: {
      accountId_scopeKey: {
        accountId,
        scopeKey: scope,
      },
    },
    create: {
      accountId,
      scopeKey: scope,
      failedAttempts: 0,
      lockLevel: 0,
      lockedUntil: null,
      lastSuccessAt: new Date(),
    },
    update: {
      failedAttempts: 0,
      lockLevel: 0,
      lockedUntil: null,
      lastSuccessAt: new Date(),
    },
  }).catch(() => undefined);
}


function publicCredential(credential: Record<string, unknown>) {
  return {
    id: credential.id,
    method: credential.method,
    label: credential.label,
    status: credential.status,
    confirmedAt: credential.confirmedAt,
    lastUsedAt: credential.lastUsedAt,
    createdAt: credential.createdAt,
  };
}

function getMeta(meta?: RequestMeta) {
  return {
    ipAddress: meta?.ip,
    userAgent: meta?.userAgent,
  };
}

async function writeAudit(input: {
  accountId?: string;
  event: string;
  purpose?: TwoFactorPurpose;
  method?: "TOTP" | "RECOVERY_CODE" | "WEBAUTHN";
  result: "SUCCESS" | "FAILURE" | "BLOCKED";
  meta?: RequestMeta;
  metadataJson?: unknown;
}) {
  const meta = getMeta(input.meta);

  await db.securityTwoFactorAuditLog.create({
    data: {
      accountId: input.accountId,
      event: input.event,
      purpose: input.purpose,
      method: input.method,
      result: input.result,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadataJson: input.metadataJson,
    },
  }).catch(() => undefined);

  await db.securityLog?.create?.({
    data: {
      category: "TWO_FACTOR",
      event: input.event,
      severity: input.result === "SUCCESS" ? "INFO" : "WARN",
      accountId: input.accountId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadataJson: input.metadataJson,
    },
  }).catch(() => undefined);
}

async function getActiveTotpCredential(accountId: string): Promise<ActiveCredential | null> {
  return db.securityTwoFactorCredential.findFirst({
    where: {
      accountId,
      method: "TOTP",
      status: "ACTIVE",
    },
    orderBy: {
      confirmedAt: "desc",
    },
  });
}

export async function hasActiveTwoFactor(accountId: string) {
  const provider = await getProviderContext();
  if (provider.externallyManaged) return provider.configured;
  const credential = await getActiveTotpCredential(accountId);
  return Boolean(credential);
}

async function privateDataProtectionEnrollment(
  accountId: string,
  provider: Awaited<ReturnType<typeof getProviderContext>>,
) {
  const existing = await db.securityTwoFactorAuditLog.findFirst({
    where: {
      accountId,
      event: PRIVATE_DATA_PROTECTION_ENROLLED_EVENT,
      result: "SUCCESS",
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    return { enrolled: true, enrolledAt: existing.createdAt };
  }
  if (!(provider.externallyManaged && provider.configured)) {
    return { enrolled: false, enrolledAt: null };
  }

  const createdAt = new Date();
  // Anders als gewoehnliche Telemetrie darf diese Schreiboperation nicht
  // stillschweigend fehlschlagen: Ohne persistierte Marke duerfte das System
  // den Schutz spaeter versehentlich wieder als optional behandeln.
  await db.securityTwoFactorAuditLog.create({
    data: {
      accountId,
      event: PRIVATE_DATA_PROTECTION_ENROLLED_EVENT,
      purpose: "MODULE_PRIVATE_DATA_ACCESS",
      result: "SUCCESS",
      metadataJson: {
        provider: provider.id,
        irreversible: true,
        resetPolicy: "PROTECTED_DATA_DELETION_ONLY",
      },
    },
  });
  return { enrolled: true, enrolledAt: createdAt };
}

export async function getStatus(accountId: string) {
  const [provider, credentials, recoveryCodes, lockouts] = await Promise.all([
    getProviderContext(),
    db.securityTwoFactorCredential.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
    }),
    db.securityTwoFactorRecoveryCode.count({
      where: { accountId, usedAt: null },
    }),
    db.securityTwoFactorLockout?.findMany?.({
      where: { accountId },
      orderBy: { updatedAt: "desc" },
    }) ?? [],
  ]);

  const activeCredentials = credentials.filter((credential: any) => credential.status === "ACTIVE");
  const externallyManaged = provider.externallyManaged;
  const enabled = externallyManaged ? provider.configured : activeCredentials.length > 0;
  const privateDataProtection = await privateDataProtectionEnrollment(accountId, provider);

  return {
    enabled,
    provider: {
      id: provider.id,
      label: provider.label,
      configured: provider.configured,
      externallyManaged,
      details: provider.details,
      proofFields: provider.policy.proofFields,
    },
    methods: externallyManaged && enabled
      ? [provider.id.toUpperCase()]
      : activeCredentials.map((credential: any) => credential.method),
    credentials: credentials.map(publicCredential),
    unusedRecoveryCodeCount: recoveryCodes,
    maxAttempts: provider.policy.maxAttempts,
    challengeExpiresSeconds: provider.policy.challengeExpiresSeconds,
    privateDataProtectionEnrolled: privateDataProtection.enrolled,
    privateDataProtectionEnrolledAt: privateDataProtection.enrolledAt,
    lockoutPolicy: {
      maxAttempts: provider.policy.maxAttempts,
      firstLockMinutes: TWO_FACTOR_BASE_LOCK_MINUTES,
      escalation: "DOUBLE_AFTER_EACH_LOCKOUT",
      maxLockMinutes: TWO_FACTOR_MAX_LOCK_MINUTES,
    },
    activeLockouts: lockouts
      .filter((lockout: any) => lockout.lockedUntil && lockout.lockedUntil.getTime() > Date.now())
      .map((lockout: any) => ({
        scopeKey: lockout.scopeKey,
        lockedUntil: lockout.lockedUntil,
        lockLevel: lockout.lockLevel,
      })),
  };
}

export async function setupTotp(accountId: string, input: SetupTotpInput, meta?: RequestMeta) {
  if ((await getProviderContext()).externallyManaged) {
    throw httpError("TWO_FACTOR_MANAGED_BY_EXTERNAL_PROVIDER", 409);
  }
  const active = await getActiveTotpCredential(accountId);

  if (active) {
    throw httpError("TWO_FACTOR_TOTP_ALREADY_ACTIVE", 409);
  }

  await db.securityTwoFactorCredential.updateMany({
    where: {
      accountId,
      method: "TOTP",
      status: "PENDING",
    },
    data: {
      status: "REVOKED",
      disabledAt: new Date(),
    },
  }).catch(() => undefined);

  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { loginName: true, email: true },
  });

  if (!account) {
    throw httpError("ACCOUNT_NOT_FOUND", 404);
  }

  const issuer = input.issuer || "Bonni Core";
  const label = input.label || account.email || account.loginName || accountId;
  const secret = generateTotpSecret();

  const credential = await db.securityTwoFactorCredential.create({
    data: {
      accountId,
      method: "TOTP",
      label,
      secretEncrypted: encryptSecret(secret),
      secretFingerprint: fingerprintSecret(secret),
      status: "PENDING",
      metadataJson: {
        issuer,
      },
    },
  });

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_TOTP_SETUP_STARTED",
    method: "TOTP",
    result: "SUCCESS",
    meta,
    metadataJson: { credentialId: credential.id },
  });

  const otpauthUri = buildTotpOtpauthUri({ issuer, label, secret });
  const qrCodeDataUrl = await buildTotpQrCodeDataUrl(otpauthUri);

  return {
    credentialId: credential.id,
    method: "TOTP",
    otpauthUri,
    qrCodeDataUrl,
    issuer,
    label,
    manualEntrySecret: input.includeManualSecret ? secret : undefined,
    note: "QR-Code und otpauthUri nur während der Einrichtung anzeigen. Der geheime Schlüssel wird standardmäßig nicht als Klartext ausgegeben.",
  };
}

async function createRecoveryCodes(accountId: string, count = 10) {
  await db.securityTwoFactorRecoveryCode.deleteMany({
    where: {
      accountId,
      usedAt: null,
    },
  });

  const codes = Array.from({ length: count }, () => generateRecoveryCode());

  await db.securityTwoFactorRecoveryCode.createMany({
    data: codes.map((code) => ({
      accountId,
      codeHash: recoveryCodeHash(accountId, code),
      lastFour: normalizeRecoveryCode(code).slice(-4),
    })),
  });

  return codes;
}

export async function confirmTotp(accountId: string, input: ConfirmTotpInput, meta?: RequestMeta) {
  if ((await getProviderContext()).externallyManaged) {
    throw httpError("TWO_FACTOR_MANAGED_BY_EXTERNAL_PROVIDER", 409);
  }
  const credential = await db.securityTwoFactorCredential.findFirst({
    where: {
      id: input.credentialId,
      accountId,
      method: "TOTP",
      status: "PENDING",
    },
  });

  if (!credential?.secretEncrypted) {
    throw httpError("TWO_FACTOR_PENDING_CREDENTIAL_NOT_FOUND", 404);
  }

  const setupScope = scopeKey("TOTP_SETUP");
  await assertNotLocked(accountId, setupScope, meta);

  const secret = decryptSecret(credential.secretEncrypted);

  if (!verifyTotpCode(secret, input.code)) {
    await writeAudit({
      accountId,
      event: "TWO_FACTOR_TOTP_CONFIRM_FAILED",
      method: "TOTP",
      result: "FAILURE",
      meta,
      metadataJson: { credentialId: credential.id },
    });

    const lockout = await registerFailedAttempt({
      accountId,
      scope: setupScope,
      method: "TOTP",
      meta,
      metadataJson: { credentialId: credential.id },
    });

    if (lockout.locked) {
      throw httpError("TWO_FACTOR_TEMPORARILY_LOCKED", 423, lockout);
    }

    throw httpError("TWO_FACTOR_INVALID_CODE", 401, lockout);
  }

  await registerSuccessfulAttempt(accountId, setupScope);

  const now = new Date();
  const updated = await db.securityTwoFactorCredential.update({
    where: { id: credential.id },
    data: {
      status: "ACTIVE",
      confirmedAt: now,
      lastUsedAt: now,
    },
  });

  const recoveryCodes = await createRecoveryCodes(accountId);

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_TOTP_ENABLED",
    method: "TOTP",
    result: "SUCCESS",
    meta,
    metadataJson: { credentialId: credential.id },
  });

  return {
    credential: publicCredential(updated),
    recoveryCodes,
    recoveryCodesNote: "Diese Wiederherstellungscodes nur einmal anzeigen und sicher offline ablegen.",
  };
}

export async function createChallenge(
  accountId: string,
  input: CreateChallengeInput | { purpose: TwoFactorPurpose; method?: "TOTP" | "RECOVERY_CODE"; metadataJson?: unknown },
  meta?: RequestMeta,
) {
  const method = input.method || "TOTP";
  const challengeScope = scopeKey(input.purpose);
  const provider = await getProviderContext();
  await assertNotLocked(
    accountId,
    challengeScope,
    meta,
    input.purpose,
    provider.policy.maxAttempts,
  );
  const credential = provider.externallyManaged ? null : await getActiveTotpCredential(accountId);

  if (!provider.configured || (!provider.externallyManaged && !credential)) {
    await writeAudit({
      accountId,
      event: "TWO_FACTOR_CHALLENGE_BLOCKED_NOT_CONFIGURED",
      purpose: input.purpose,
      method,
      result: "BLOCKED",
      meta,
      metadataJson: { provider: provider.id },
    });

    throw httpError("TWO_FACTOR_NOT_CONFIGURED", 409);
  }

  const challenge = await db.securityTwoFactorChallenge.create({
    data: {
      accountId,
      purpose: input.purpose,
      method,
      credentialId: credential?.id,
      status: "PENDING",
      maxAttempts: provider.policy.maxAttempts,
      expiresAt: addSeconds(provider.policy.challengeExpiresSeconds),
      ipAddress: meta?.ip,
      userAgent: meta?.userAgent,
      metadataJson: {
        ...(input.metadataJson && typeof input.metadataJson === "object"
          ? input.metadataJson as Record<string, unknown>
          : {}),
        twoFactorProvider: provider.id,
      },
    },
  });

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_CHALLENGE_CREATED",
    purpose: input.purpose,
    method,
    result: "SUCCESS",
    meta,
    metadataJson: { challengeId: challenge.id, provider: provider.id },
  });

  return {
    id: challenge.id,
    purpose: challenge.purpose,
    method: provider.externallyManaged ? "EXTERNAL" : challenge.method,
    provider: provider.id,
    providerLabel: provider.label,
    proofFields: provider.policy.proofFields,
    status: challenge.status,
    expiresAt: challenge.expiresAt,
    maxAttempts: challenge.maxAttempts,
  };
}

async function verifyRecoveryCode(accountId: string, code: string) {
  const codeHash = recoveryCodeHash(accountId, code);
  const recoveryCode = await db.securityTwoFactorRecoveryCode.findUnique({
    where: { codeHash },
  });

  if (!recoveryCode || recoveryCode.accountId !== accountId || recoveryCode.usedAt) {
    return false;
  }

  await db.securityTwoFactorRecoveryCode.update({
    where: { id: recoveryCode.id },
    data: { usedAt: new Date() },
  });

  return true;
}

async function verifyCodeForAccount(
  accountId: string,
  input: TwoFactorProof,
  requiredProvider = "local",
  purpose = "",
): Promise<CodeVerification> {
  if (requiredProvider !== "local") {
    const provider = getRegisteredExternalTwoFactorProviderById(requiredProvider);
    if (!provider) throw httpError("TWO_FACTOR_PROVIDER_CHANGED", 409);
    const state = await provider.getState();
    if (!state.enabled || !state.configured) throw httpError("TWO_FACTOR_NOT_CONFIGURED", 409);
    const account = await db.account.findUnique({
      where: { id: accountId },
      select: { loginName: true },
    });
    if (!account?.loginName) return { ok: false, method: "TOTP", provider: provider.id };
    let verification: { ok: boolean };
    try {
      verification = await provider.verify({
        accountId,
        loginName: account.loginName,
        purpose,
        proof: input,
      });
    } catch (error: any) {
      if (Number(error?.statusCode || error?.status) === 503) {
        throw httpError("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
      }
      if (Number(error?.statusCode || error?.status) >= 400 && Number(error?.statusCode || error?.status) < 500) {
        throw httpError("TWO_FACTOR_PROVIDER_REJECTED_REQUEST", 400);
      }
      throw httpError("TWO_FACTOR_PROVIDER_FAILED", 502);
    }
    return { ok: verification.ok, method: "TOTP", provider: provider.id };
  }

  if (input.recoveryCode) {
    const recoveryOk = await verifyRecoveryCode(accountId, input.recoveryCode);
    return {
      ok: recoveryOk,
      method: "RECOVERY_CODE" as const,
      provider: "local",
    };
  }

  if (!input.code) {
    return {
      ok: false,
      method: "TOTP" as const,
      provider: "local",
    };
  }

  const credential = await getActiveTotpCredential(accountId);

  if (!credential?.secretEncrypted) {
    return {
      ok: false,
      method: "TOTP" as const,
      provider: "local",
    };
  }

  const secret = decryptSecret(credential.secretEncrypted);
  const ok = verifyTotpCode(secret, input.code);

  if (ok) {
    await db.securityTwoFactorCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });
  }

  return {
    ok,
    method: "TOTP" as const,
    credentialId: credential.id,
    provider: "local",
  };
}

export async function verifyChallenge(
  accountId: string,
  challengeId: string,
  input: TwoFactorProof,
  meta?: RequestMeta,
) {
  const challenge = await db.securityTwoFactorChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.accountId !== accountId) {
    throw httpError("TWO_FACTOR_CHALLENGE_NOT_FOUND", 404);
  }

  const challengeScope = scopeKey(challenge.purpose);
  const effectiveMaxAttempts = boundedInteger(
    challenge.maxAttempts,
    LOCAL_TWO_FACTOR_MAX_ATTEMPTS,
    1,
    20,
  );
  await assertNotLocked(accountId, challengeScope, meta, challenge.purpose, effectiveMaxAttempts);

  if (challenge.status !== "PENDING") {
    throw httpError("TWO_FACTOR_CHALLENGE_NOT_PENDING", 409);
  }

  if (challenge.expiresAt < new Date()) {
    await db.securityTwoFactorChallenge.update({
      where: { id: challenge.id },
      data: { status: "EXPIRED" },
    });

    throw httpError("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
  }

  if (challenge.attempts >= effectiveMaxAttempts) {
    await db.securityTwoFactorChallenge.update({
      where: { id: challenge.id },
      data: { status: "FAILED" },
    });

    const lockout = await registerFailedAttempt({
      accountId,
      scope: challengeScope,
      purpose: challenge.purpose,
      method: challenge.method,
      meta,
      metadataJson: { challengeId: challenge.id, reason: "MAX_ATTEMPTS_REACHED" },
      maxAttempts: effectiveMaxAttempts,
    });

    throw httpError(lockout.locked ? "TWO_FACTOR_TEMPORARILY_LOCKED" : "TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS", 423, lockout);
  }

  const challengeMetadata = challenge.metadataJson && typeof challenge.metadataJson === "object"
    ? challenge.metadataJson as Record<string, unknown>
    : {};
  const challengeProvider = String(challengeMetadata.twoFactorProvider || "local").trim().toLowerCase();
  const verification = await verifyCodeForAccount(
    accountId,
    input,
    challengeProvider,
    challenge.purpose,
  );

  if (!verification.ok) {
    const attempts = challenge.attempts + 1;
    const lockout = await registerFailedAttempt({
      accountId,
      scope: challengeScope,
      purpose: challenge.purpose,
      method: verification.method,
      meta,
      metadataJson: { challengeId: challenge.id, attempts, provider: verification.provider },
      maxAttempts: effectiveMaxAttempts,
    });

    await db.securityTwoFactorChallenge.update({
      where: { id: challenge.id },
      data: {
        attempts,
        status: attempts >= effectiveMaxAttempts || lockout.locked ? "FAILED" : "PENDING",
      },
    });

    await writeAudit({
      accountId,
      event: lockout.locked ? "TWO_FACTOR_CHALLENGE_LOCKED_AFTER_FAILURES" : "TWO_FACTOR_CHALLENGE_VERIFY_FAILED",
      purpose: challenge.purpose,
      method: verification.method,
      result: lockout.locked ? "BLOCKED" : "FAILURE",
      meta,
      metadataJson: { challengeId: challenge.id, attempts, provider: verification.provider, ...lockout },
    });

    if (lockout.locked) {
      throw httpError("TWO_FACTOR_TEMPORARILY_LOCKED", 423, lockout);
    }

    throw httpError("TWO_FACTOR_INVALID_CODE", 401, lockout);
  }

  await registerSuccessfulAttempt(accountId, challengeScope);

  const verified = await db.securityTwoFactorChallenge.update({
    where: { id: challenge.id },
    data: {
      status: "VERIFIED",
      verifiedAt: new Date(),
      method: verification.method,
      credentialId: verification.credentialId ?? challenge.credentialId,
    },
  });

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_CHALLENGE_VERIFIED",
    purpose: challenge.purpose,
    method: verification.method,
    result: "SUCCESS",
    meta,
    metadataJson: { challengeId: challenge.id, provider: verification.provider },
  });

  return {
    id: verified.id,
    accountId: verified.accountId,
    purpose: verified.purpose,
    method: verified.method,
    status: verified.status,
    verifiedAt: verified.verifiedAt,
    expiresAt: verified.expiresAt,
    provider: verification.provider,
  };
}

export async function verifyLoginChallenge(
  challengeId: string,
  input: TwoFactorProof,
  meta?: RequestMeta,
) {
  const challenge = await db.securityTwoFactorChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.purpose !== "LOGIN") {
    throw httpError("TWO_FACTOR_LOGIN_CHALLENGE_NOT_FOUND", 404);
  }

  return verifyChallenge(challenge.accountId, challenge.id, input, meta);
}

export async function consumeVerifiedChallenge(input: {
  accountId: string;
  challengeId: string;
  purpose: TwoFactorPurpose;
  maxAgeMinutes?: number;
  metadata?: Record<string, string>;
}) {
  const challenge = await db.securityTwoFactorChallenge.findUnique({
    where: { id: input.challengeId },
  });

  if (!challenge || challenge.accountId !== input.accountId || challenge.purpose !== input.purpose) {
    throw httpError("TWO_FACTOR_AUTHORIZATION_NOT_FOUND", 404);
  }

  if (input.metadata) {
    const challengeMetadata = challenge.metadataJson && typeof challenge.metadataJson === "object"
      ? challenge.metadataJson as Record<string, unknown>
      : {};
    const metadataMatches = Object.entries(input.metadata).every(
      ([key, value]) => String(challengeMetadata[key] ?? "") === value,
    );
    if (!metadataMatches) {
      throw httpError("TWO_FACTOR_AUTHORIZATION_SCOPE_MISMATCH", 403);
    }
  }

  if (challenge.status !== "VERIFIED" || !challenge.verifiedAt || challenge.consumedAt) {
    throw httpError("TWO_FACTOR_AUTHORIZATION_NOT_USABLE", 409);
  }

  const maxAgeMs = (input.maxAgeMinutes ?? 10) * 60 * 1000;
  if (challenge.verifiedAt.getTime() + maxAgeMs < Date.now()) {
    throw httpError("TWO_FACTOR_AUTHORIZATION_EXPIRED", 401);
  }

  return db.securityTwoFactorChallenge.update({
    where: { id: challenge.id },
    data: {
      status: "CONSUMED",
      consumedAt: new Date(),
    },
  });
}

async function verifyPassword(accountId: string, password?: string) {
  if (!password) {
    return false;
  }

  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { passwordHash: true },
  });

  return Boolean(account?.passwordHash && await bcrypt.compare(password, account.passwordHash));
}

async function assertSensitiveSettingsProof(accountId: string, input: TwoFactorProof, meta?: RequestMeta) {
  const has2fa = await hasActiveTwoFactor(accountId);
  const settingsScope = scopeKey("SECURITY_SETTINGS");

  if (has2fa) {
    const provider = await getProviderContext();
    await assertNotLocked(
      accountId,
      settingsScope,
      meta,
      "SECURITY_SETTINGS",
      provider.policy.maxAttempts,
    );

    const verified = await verifyCodeForAccount(
      accountId,
      input,
      provider.id,
      "SECURITY_SETTINGS",
    );
    if (!verified.ok) {
      const lockout = await registerFailedAttempt({
        accountId,
        scope: settingsScope,
        purpose: "SECURITY_SETTINGS",
        method: verified.method,
        meta,
        maxAttempts: provider.policy.maxAttempts,
      });

      if (lockout.locked) {
        throw httpError("TWO_FACTOR_TEMPORARILY_LOCKED", 423, lockout);
      }

      throw httpError("TWO_FACTOR_INVALID_CODE", 401, lockout);
    }

    await registerSuccessfulAttempt(accountId, settingsScope);
    return verified.method;
  }

  if (await verifyPassword(accountId, input.password)) {
    return "PASSWORD";
  }

  throw httpError("TWO_FACTOR_SECURITY_PROOF_REQUIRED", 401);
}

export async function disableTwoFactor(accountId: string, input: DisableTwoFactorInput, meta?: RequestMeta) {
  if ((await getProviderContext()).externallyManaged) {
    throw httpError("TWO_FACTOR_MANAGED_BY_EXTERNAL_PROVIDER", 409);
  }
  const proofMethod = await assertSensitiveSettingsProof(accountId, input, meta);
  const where = input.credentialId
    ? { id: input.credentialId, accountId, method: "TOTP", status: "ACTIVE" }
    : { accountId, method: "TOTP", status: "ACTIVE" };

  const result = await db.securityTwoFactorCredential.updateMany({
    where,
    data: {
      status: "DISABLED",
      disabledAt: new Date(),
    },
  });

  await db.securityTwoFactorRecoveryCode.deleteMany({
    where: { accountId, usedAt: null },
  });

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_DISABLED",
    method: "TOTP",
    result: "SUCCESS",
    meta,
    metadataJson: { affected: result.count, proofMethod },
  });

  return {
    disabled: result.count,
  };
}

export async function regenerateRecoveryCodes(accountId: string, input: RegenerateRecoveryCodesInput, meta?: RequestMeta) {
  if ((await getProviderContext()).externallyManaged) {
    throw httpError("TWO_FACTOR_MANAGED_BY_EXTERNAL_PROVIDER", 409);
  }
  const proofMethod = await assertSensitiveSettingsProof(accountId, input, meta);

  if (!await hasActiveTwoFactor(accountId)) {
    throw httpError("TWO_FACTOR_NOT_CONFIGURED", 409);
  }

  const recoveryCodes = await createRecoveryCodes(accountId);

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_RECOVERY_CODES_REGENERATED",
    method: "RECOVERY_CODE",
    result: "SUCCESS",
    meta,
    metadataJson: { proofMethod },
  });

  return {
    recoveryCodes,
    recoveryCodesNote: "Diese Wiederherstellungscodes nur einmal anzeigen und sicher offline ablegen.",
  };
}
