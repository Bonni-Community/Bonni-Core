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
  | "DSGVO_DELETION_RULE_UPDATE";

type ActiveCredential = {
  id: string;
  accountId: string;
  method: "TOTP" | "RECOVERY_CODE" | "WEBAUTHN";
  label?: string | null;
  secretEncrypted?: string | null;
  status: string;
};

function httpError(code: string, statusCode = 400, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { statusCode, code, details });
}

function addMinutes(minutes: number) {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

const TWO_FACTOR_MAX_ATTEMPTS = 3;
const TWO_FACTOR_BASE_LOCK_MINUTES = 3;
const TWO_FACTOR_MAX_LOCK_MINUTES = 24 * 60;


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

function lockoutPayload(lockout: any) {
  return {
    lockedUntil: lockout?.lockedUntil,
    failedAttempts: lockout?.failedAttempts ?? 0,
    maxAttempts: TWO_FACTOR_MAX_ATTEMPTS,
    lockLevel: lockout?.lockLevel ?? 0,
  };
}

async function assertNotLocked(accountId: string, scope: string, meta?: RequestMeta, purpose?: TwoFactorPurpose) {
  const lockout = await getLockout(accountId, scope);

  if (lockout?.lockedUntil && lockout.lockedUntil.getTime() > Date.now()) {
    await writeAudit({
      accountId,
      event: "TWO_FACTOR_LOCKOUT_BLOCKED",
      purpose,
      result: "BLOCKED",
      meta,
      metadataJson: { scope, ...lockoutPayload(lockout) },
    });

    throw httpError("TWO_FACTOR_TEMPORARILY_LOCKED", 423, lockoutPayload(lockout));
  }
}

async function registerFailedAttempt(input: {
  accountId: string;
  scope: string;
  purpose?: TwoFactorPurpose;
  method?: "TOTP" | "RECOVERY_CODE" | "WEBAUTHN";
  meta?: RequestMeta;
  metadataJson?: unknown;
}) {
  const existing = await getLockout(input.accountId, input.scope);
  const failedAttempts = (existing?.failedAttempts ?? 0) + 1;

  if (failedAttempts < TWO_FACTOR_MAX_ATTEMPTS) {
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

    return { locked: false, ...lockoutPayload(lockout) };
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
      ...lockoutPayload(lockout),
    },
  });

  return { locked: true, lockMinutes, ...lockoutPayload(lockout) };
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
  const credential = await getActiveTotpCredential(accountId);
  return Boolean(credential);
}

export async function getStatus(accountId: string) {
  const [credentials, recoveryCodes, lockouts] = await Promise.all([
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

  return {
    enabled: activeCredentials.length > 0,
    methods: activeCredentials.map((credential: any) => credential.method),
    credentials: credentials.map(publicCredential),
    unusedRecoveryCodeCount: recoveryCodes,
    maxAttempts: TWO_FACTOR_MAX_ATTEMPTS,
    lockoutPolicy: {
      maxAttempts: TWO_FACTOR_MAX_ATTEMPTS,
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
  await assertNotLocked(accountId, challengeScope, meta, input.purpose);

  const credential = await getActiveTotpCredential(accountId);

  if (!credential) {
    await writeAudit({
      accountId,
      event: "TWO_FACTOR_CHALLENGE_BLOCKED_NOT_CONFIGURED",
      purpose: input.purpose,
      method,
      result: "BLOCKED",
      meta,
    });

    throw httpError("TWO_FACTOR_NOT_CONFIGURED", 409);
  }

  const challenge = await db.securityTwoFactorChallenge.create({
    data: {
      accountId,
      purpose: input.purpose,
      method,
      credentialId: credential.id,
      status: "PENDING",
      maxAttempts: TWO_FACTOR_MAX_ATTEMPTS,
      expiresAt: addMinutes(10),
      ipAddress: meta?.ip,
      userAgent: meta?.userAgent,
      metadataJson: input.metadataJson,
    },
  });

  await writeAudit({
    accountId,
    event: "TWO_FACTOR_CHALLENGE_CREATED",
    purpose: input.purpose,
    method,
    result: "SUCCESS",
    meta,
    metadataJson: { challengeId: challenge.id },
  });

  return {
    id: challenge.id,
    purpose: challenge.purpose,
    method: challenge.method,
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

async function verifyCodeForAccount(accountId: string, input: { code?: string; recoveryCode?: string }) {
  if (input.recoveryCode) {
    const recoveryOk = await verifyRecoveryCode(accountId, input.recoveryCode);
    return {
      ok: recoveryOk,
      method: "RECOVERY_CODE" as const,
    };
  }

  if (!input.code) {
    return {
      ok: false,
      method: "TOTP" as const,
    };
  }

  const credential = await getActiveTotpCredential(accountId);

  if (!credential?.secretEncrypted) {
    return {
      ok: false,
      method: "TOTP" as const,
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
  };
}

export async function verifyChallenge(
  accountId: string,
  challengeId: string,
  input: { code?: string; recoveryCode?: string },
  meta?: RequestMeta,
) {
  const challenge = await db.securityTwoFactorChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.accountId !== accountId) {
    throw httpError("TWO_FACTOR_CHALLENGE_NOT_FOUND", 404);
  }

  const challengeScope = scopeKey(challenge.purpose);
  await assertNotLocked(accountId, challengeScope, meta, challenge.purpose);

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

  const effectiveMaxAttempts = Math.min(challenge.maxAttempts ?? TWO_FACTOR_MAX_ATTEMPTS, TWO_FACTOR_MAX_ATTEMPTS);

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
    });

    throw httpError(lockout.locked ? "TWO_FACTOR_TEMPORARILY_LOCKED" : "TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS", 423, lockout);
  }

  const verification = await verifyCodeForAccount(accountId, input);

  if (!verification.ok) {
    const attempts = challenge.attempts + 1;
    const lockout = await registerFailedAttempt({
      accountId,
      scope: challengeScope,
      purpose: challenge.purpose,
      method: verification.method,
      meta,
      metadataJson: { challengeId: challenge.id, attempts },
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
      metadataJson: { challengeId: challenge.id, attempts, ...lockout },
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
    metadataJson: { challengeId: challenge.id },
  });

  return {
    id: verified.id,
    accountId: verified.accountId,
    purpose: verified.purpose,
    method: verified.method,
    status: verified.status,
    verifiedAt: verified.verifiedAt,
    expiresAt: verified.expiresAt,
  };
}

export async function verifyLoginChallenge(
  challengeId: string,
  input: { code?: string; recoveryCode?: string },
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
}) {
  const challenge = await db.securityTwoFactorChallenge.findUnique({
    where: { id: input.challengeId },
  });

  if (!challenge || challenge.accountId !== input.accountId || challenge.purpose !== input.purpose) {
    throw httpError("TWO_FACTOR_AUTHORIZATION_NOT_FOUND", 404);
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

async function assertSensitiveSettingsProof(accountId: string, input: { code?: string; recoveryCode?: string; password?: string }, meta?: RequestMeta) {
  const has2fa = await hasActiveTwoFactor(accountId);
  const settingsScope = scopeKey("SECURITY_SETTINGS");

  if (has2fa) {
    await assertNotLocked(accountId, settingsScope, meta, "SECURITY_SETTINGS");

    const verified = await verifyCodeForAccount(accountId, input);
    if (!verified.ok) {
      const lockout = await registerFailedAttempt({
        accountId,
        scope: settingsScope,
        purpose: "SECURITY_SETTINGS",
        method: verified.method,
        meta,
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
