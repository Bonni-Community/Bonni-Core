import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { AccountType } from "@prisma/client";

import { getServerPrismaClient } from "../../../core/database/database.js";
import { LoginError, normalizeLoginError } from "../../../core/errors/login-error.js";
import { validateExactLocalPassword } from "../../../core/modules/identity/local-password-policy.js";
import { listModuleManifests } from "../../module-manager/manifests/index.js";
import type {
  ModuleAccessProfile,
  ModuleManifestSummary,
} from "../../module-manager/types.js";
import { ensureLocalBootstrapAdminAccess } from "../bootstrap-admin-access.js";
import { verifyPasswordRuntime } from "../password-runtime.js";
import { isForbiddenInteractiveLoginName } from "../system-account-policy.js";
import { coreTokenService } from "../token/core-token.service.js";
import * as twoFactorService from "../../../core/modules/security/two-factor/service.js";

const router = Router();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
// Accounts and sessions belong to Bonni Core. Authentication must therefore
// never follow a local/app request surface into another database context.
const prisma = getServerPrismaClient("core");

type AccountWithAuth = Awaited<ReturnType<typeof findAccountForLogin>>;

type LoginMfaAssurance = Readonly<{
  verifiedAt: Date;
  providerId: string;
  method: string | null;
}>;

type AccessKind = "control-center" | "app" | "add-on" | "plug-in";

type ModuleAccessSummary = {
  kind: AccessKind;
  moduleKey: string;
  moduleName: string;
  permissions: string[];
};

type ResolvedModuleAccess = ModuleAccessSummary & {
  appRoute: string | null;
  route: string | null;
  manifestRoute: string | null;
  workspace: string | null;
  profiles: ModuleAccessProfile[];
};

function normalizeLoginName(value: unknown) {
  return String(value || "").trim();
}

async function findAccountForLogin(loginName: string) {
  const account = await prisma.account.findUnique({
    where: { loginName },
    include: {
      person: {
        include: {
          member: true,
        },
      },
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
      accountMemberCapabilities: {
        include: {
          capability: true,
        },
      },
      authProvider: true,
    },
  });

  return account;
}

async function findAccountForLoginById(accountId: string) {
  return prisma.account.findUnique({
    where: { id: accountId },
    include: {
      person: { include: { member: true } },
      roles: {
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      },
      accountMemberCapabilities: { include: { capability: true } },
      authProvider: true,
    },
  });
}

async function repairBootstrapAdminAccess(account: NonNullable<AccountWithAuth>) {
  const repaired = await ensureLocalBootstrapAdminAccess(prisma, account);
  if (!repaired) return account;

  return await findAccountForLogin(account.loginName) || account;
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function accessSlug(value: unknown, fallback = "module") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeAccessKind(value: unknown): AccessKind | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");

  if (["control-center", "control center", "controlcenter", "control"].includes(normalized)) return "control-center";
  if (normalized === "app") return "app";
  if (["add-on", "addon"].includes(normalized)) return "add-on";
  if (["plug-in", "plugin"].includes(normalized)) return "plug-in";

  return null;
}

function mergeModuleAccess(assignments: ModuleAccessSummary[]) {
  const grouped = new Map<string, ModuleAccessSummary>();

  assignments.forEach((assignment) => {
    const key = `${assignment.kind}:${accessSlug(assignment.moduleKey)}:${accessSlug(assignment.moduleName)}`;
    const current = grouped.get(key);

    if (current) {
      current.permissions = unique([...current.permissions, ...assignment.permissions]);
      return;
    }

    grouped.set(key, {
      ...assignment,
      permissions: unique(assignment.permissions),
    });
  });

  return [...grouped.values()];
}

function moduleAccessFromRoles(account: NonNullable<AccountWithAuth>) {
  const assignments = account.roles.flatMap((entry) => {
    const roleKey = String(entry.role.key || "").trim();
    const roleLabel = String(entry.role.label || roleKey).trim();
    const normalizedRoleKey = roleKey.toLowerCase();

    if (normalizedRoleKey === "admin" || roleLabel.toLowerCase() === "administrator") {
      return [{
        kind: "control-center" as const,
        moduleKey: "control-center",
        moduleName: "Control Center",
        permissions: ["Administrator"],
      }];
    }

    // App-Zugriff wird ausschließlich aus dem kanonischen technischen
    // Rollenschlüssel gelesen. Anzeigenamen und alte Berechtigungsschlüssel
    // dürfen niemals einen App-Zugriff erzeugen.
    const keyParts = normalizedRoleKey.startsWith("access:") ? roleKey.split(":") : [];
    if (keyParts.length !== 4) return [];

    const kind = normalizeAccessKind(keyParts[1]);
    const moduleKey = String(keyParts[2] || "").trim();
    const moduleName = moduleKey;
    const permission = String(keyParts[3] || "").trim();

    if (!kind || !moduleKey || !moduleName || !permission) return [];
    if (kind === "app" && (!/^app-[a-z0-9-]+$/i.test(moduleKey) || !/^[a-z0-9-]+$/i.test(permission))) {
      return [];
    }

    return [{
      kind,
      moduleKey,
      moduleName,
      permissions: [permission],
    }];
  });

  return mergeModuleAccess(assignments);
}

function manifestAccessKind(manifest: ModuleManifestSummary): AccessKind {
  if (manifest.kind === "addon") return "add-on";
  if (manifest.kind === "plugin") return "plug-in";
  return "app";
}

function findAccessManifest(
  assignment: ModuleAccessSummary,
  manifests: ModuleManifestSummary[],
) {
  const moduleKey = accessSlug(assignment.moduleKey);
  const moduleName = accessSlug(assignment.moduleName);

  return manifests.find((manifest) => (
    manifestAccessKind(manifest) === assignment.kind
    && (
      accessSlug(manifest.key) === moduleKey
      || accessSlug(manifest.name) === moduleName
    )
  )) || null;
}

function fallbackModuleKey(assignment: ModuleAccessSummary) {
  if (assignment.kind === "control-center") return "control-center";

  const storedKey = String(assignment.moduleKey || "").trim();
  if (assignment.kind === "app" && storedKey.startsWith("app-")) {
    return `app.${storedKey.slice(4)}`;
  }

  if (storedKey.includes(".")) return storedKey;

  const prefix = assignment.kind === "add-on"
    ? "addon"
    : assignment.kind === "plug-in"
      ? "plugin"
      : "app";

  return `${prefix}.${accessSlug(assignment.moduleName).replace(/-/g, "")}`;
}

function getManifestRoute(manifest: ModuleManifestSummary | null) {
  if (!manifest) return null;

  const rawManifest = manifest as any;
  const navigation = Array.isArray(rawManifest.navigation) ? rawManifest.navigation : [];
  const firstNavigation = navigation.find((entry: any) => entry?.route || entry?.path);

  return String(
    rawManifest.frontend?.route
    || firstNavigation?.route
    || firstNavigation?.path
    || rawManifest.metadata?.route
    || "",
  ).trim() || null;
}

function normalizePermission(value: unknown) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function workspaceForPermission(value: unknown) {
  const permission = normalizePermission(value);

  if (["ADMIN", "ADMINISTRATOR", "SYSTEM_ADMIN"].includes(permission)) return "ADMIN";
  if (["MEMBER", "MITGLIED"].includes(permission)) return "MEMBER";

  return null;
}

function workspaceForAssignmentPermission(
  assignment: Pick<ModuleAccessSummary, "kind">,
  value: unknown,
) {
  // App permissions are opaque to Core. Every installed app opens in the
  // neutral member shell; only the manifest/runtime interprets its role names.
  if (assignment.kind === "app") return "MEMBER";
  return workspaceForPermission(value);
}

function accessProfilesForManifest(manifest: ModuleManifestSummary | null) {
  const profiles = manifest?.metadata?.accessProfiles;
  return Array.isArray(profiles) ? profiles : [];
}

function profileMatchesPermission(profile: ModuleAccessProfile, value: unknown) {
  const candidate = accessSlug(value, "");
  if (!candidate) return false;
  const permissionParts = profile.permission.split(".");
  return (
    accessSlug(profile.key, "") === candidate
    || accessSlug(profile.label, "") === candidate
    || accessSlug(profile.permission, "") === candidate
    || accessSlug(permissionParts[permissionParts.length - 1], "") === candidate
  );
}

function profileForPermission(
  manifest: ModuleManifestSummary | null,
  value: unknown,
) {
  return accessProfilesForManifest(manifest).find((profile) => (
    profileMatchesPermission(profile, value)
  )) || null;
}

function resolveModuleAccess(
  assignments: ModuleAccessSummary[],
  manifests: ModuleManifestSummary[],
): ResolvedModuleAccess[] {
  return assignments.map((assignment) => {
    const manifest = findAccessManifest(assignment, manifests);
    const moduleKey = manifest?.key || fallbackModuleKey(assignment);
    const moduleName = manifest?.name || assignment.moduleName;
    const interactive = assignment.kind === "app" || assignment.kind === "control-center";
    const manifestRoute = getManifestRoute(manifest);
    const appRoute = interactive ? moduleKey : null;
    const route = assignment.kind === "control-center"
      ? "/control-center"
      : assignment.kind === "app"
        ? `#${moduleKey}`
        : null;
    const profiles = unique(
      assignment.permissions.map((permission) => profileForPermission(manifest, permission)?.key),
    ).flatMap((profileKey) => (
      accessProfilesForManifest(manifest).filter((profile) => profile.key === profileKey)
    ));

    return {
      ...assignment,
      moduleKey,
      moduleName,
      appRoute,
      route,
      manifestRoute,
      workspace: unique([
        ...profiles.map((profile) => profile.workspace),
        ...assignment.permissions.map((permission) => (
          profileForPermission(manifest, permission)
            ? null
            : workspaceForAssignmentPermission(assignment, permission)
        )),
      ])[0] || null,
      profiles,
    };
  });
}

function fallbackModuleAccess(_account: NonNullable<AccountWithAuth>): ModuleAccessSummary[] {
  // Zugriffe sind immer explizit. Der technische Kontotyp allein darf weder
  // Control Center noch eine Fach-App freischalten.
  return [];
}

function resolveWorkspaceAccess(
  account: NonNullable<AccountWithAuth>,
  assignments: ResolvedModuleAccess[],
) {
  const assignedWorkspaces = assignments.flatMap((assignment) => (
    [
      ...assignment.profiles.map((profile) => profile.workspace),
      ...assignment.permissions.map((permission) => (
        assignment.profiles.some((profile) => profileMatchesPermission(profile, permission))
          ? null
          : workspaceForAssignmentPermission(assignment, permission)
      )),
    ]
  ));
  const roleWorkspaces = account.roles.map((entry) => workspaceForPermission(entry.role.key));
  const allowedWorkspaces = unique([
    ...assignedWorkspaces,
    ...roleWorkspaces,
  ]);

  if (!allowedWorkspaces.length) {
    allowedWorkspaces.push("MEMBER");
  }

  return {
    allowedWorkspaces,
    defaultWorkspace: allowedWorkspaces[0],
  };
}

function collectRoles(account: NonNullable<AccountWithAuth>) {
  return unique(account.roles.map((entry) => entry.role.key));
}

function collectPermissions(account: NonNullable<AccountWithAuth>) {
  const permissions = account.roles.flatMap((entry) =>
    entry.role.permissions.map((rolePermission) => rolePermission.permission.key),
  );

  return unique(permissions);
}

function collectCapabilities(account: NonNullable<AccountWithAuth>) {
  return unique(account.accountMemberCapabilities.map((entry) => entry.capability.key));
}

function createIdentity(
  account: NonNullable<AccountWithAuth>,
  moduleAccess: ResolvedModuleAccess[],
  allowedApps: string[],
  defaultApp: string | null,
  defaultRoute: string | null,
  allowedWorkspaces: string[],
  defaultWorkspace: string,
) {
  const roles = collectRoles(account);
  const permissions = collectPermissions(account);
  const capabilities = collectCapabilities(account);
  const displayName = account.person?.displayName || account.loginName;

  return {
    accountId: account.id,
    id: account.id,
    loginName: account.loginName,
    email: account.email,
    displayName,
    type: account.type,
    source: "LOCAL",
    status: account.isActive ? "ACTIVE" : "DISABLED",
    isSandbox: Boolean(account.isSandbox),
    personId: account.personId || null,
    memberId: account.person?.member?.id || null,
    roles,
    permissions,
    memberCapabilities: capabilities,
    moduleAccess,
    allowedApps,
    defaultApp,
    defaultRoute,
    defaultWorkspace,
    allowedWorkspaces,
  };
}

async function createShell(account: NonNullable<AccountWithAuth>) {
  let manifests: ModuleManifestSummary[] = [];

  try {
    manifests = await listModuleManifests();
  } catch (error) {
    console.warn("Auth-Shell konnte die Modul-Manifeste nicht laden", error);
  }

  const configuredAccess = moduleAccessFromRoles(account);
  const moduleAccess = resolveModuleAccess(
    configuredAccess.length ? configuredAccess : fallbackModuleAccess(account),
    manifests,
  );
  const interactiveTargets = moduleAccess.filter((assignment) => (
    assignment.kind === "app" || assignment.kind === "control-center"
  ));
  const allowedApps = unique(interactiveTargets.map((assignment) => assignment.appRoute));
  const autoOpenApp = interactiveTargets.length === 1;
  const defaultTarget = autoOpenApp ? interactiveTargets[0] : null;
  const defaultApp = defaultTarget?.appRoute || null;
  const defaultRoute = defaultTarget?.route || defaultTarget?.manifestRoute || null;
  const workspaceAccess = resolveWorkspaceAccess(account, moduleAccess);
  const identity = createIdentity(
    account,
    moduleAccess,
    allowedApps,
    defaultApp,
    defaultRoute,
    workspaceAccess.allowedWorkspaces,
    workspaceAccess.defaultWorkspace,
  );
  const roles = identity.roles;
  const permissions = identity.permissions;

  return {
    identity,
    permissions: {
      roles,
      permissions,
      allowedWorkspaces: identity.allowedWorkspaces,
      defaultWorkspace: identity.defaultWorkspace,
      moduleAccess,
      allowedApps,
      defaultApp,
      defaultModule: defaultApp,
      defaultRoute,
      autoOpenApp,
      memberCapabilities: identity.memberCapabilities,
      navigation: interactiveTargets.map((target) => ({
        key: target.moduleKey,
        label: target.moduleName,
        kind: target.kind,
        route: target.route,
        manifestRoute: target.manifestRoute,
        appRoute: target.appRoute,
        workspace: target.workspace,
      })),
      modules: unique(moduleAccess.map((assignment) => assignment.moduleKey)),
    },
    oversight: {
      ok: true,
      duplicateLogin: false,
      fallback: false,
    },
    shell: {
      ready: true,
      source: "bonni-core-auth",
      loadedAt: new Date().toISOString(),
      fallback: false,
    },
    app: {
      name: "Bonni Core",
      shellVersion: "bonni-core-auth-v1",
      defaultKey: defaultApp,
      defaultRoute,
      autoOpen: autoOpenApp,
    },
  };
}

function requestMeta(req: any) {
  return {
    ip: req.ip || undefined,
    userAgent: typeof req.headers?.["user-agent"] === "string"
      ? req.headers["user-agent"]
      : undefined,
  };
}

function sessionTokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function exactLoginMfaAssurance(value: LoginMfaAssurance | null) {
  if (!value) return null;
  const providerId = String(value.providerId || "").trim().toLowerCase();
  const method = String(value.method || "").trim().toUpperCase() || null;
  if (
    !(value.verifiedAt instanceof Date)
    || !Number.isFinite(value.verifiedAt.getTime())
    || !/^[a-z0-9][a-z0-9._:-]{0,119}$/u.test(providerId)
  ) {
    throw new LoginError(
      "TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH",
      "Der bestätigte zweite Faktor konnte nicht sicher an die Sitzung gebunden werden",
      409,
    );
  }
  return Object.freeze({ verifiedAt: value.verifiedAt, providerId, method });
}

function exactOptionalProofText(value: unknown, field: string, maxCharacters: number) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || [...value].length > maxCharacters
    || /[\r\n\0]/u.test(value)
    || Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw Object.assign(new Error("TWO_FACTOR_LOGIN_PAYLOAD_INVALID"), {
      code: "TWO_FACTOR_LOGIN_PAYLOAD_INVALID",
      statusCode: 400,
      details: { field },
    });
  }
  return value;
}

async function completeInteractiveLogin(
  account: NonNullable<AccountWithAuth>,
  req: any,
  expectedCredentialRevision = account.credentialRevision,
  loginMfaAssurance: LoginMfaAssurance | null = null,
) {
  const authenticatedAccount = await repairBootstrapAdminAccess(account);
  const mfa = exactLoginMfaAssurance(loginMfaAssurance);
  if (authenticatedAccount.passwordRecoveryLockedAt) {
    throw new LoginError("PASSWORD_RECOVERY_LOCKED", "Das Konto ist bis zum Abschluss der Wiederherstellung gesperrt", 423);
  }
  if (authenticatedAccount.credentialRevision !== expectedCredentialRevision) {
    throw new LoginError("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", "Der Sicherheitsstand des Kontos hat sich geändert", 409);
  }
  const token = await prisma.$transaction(async (transaction) => {
    const unchanged = await transaction.account.updateMany({
      where: {
        id: authenticatedAccount.id,
        isActive: true,
        credentialRevision: authenticatedAccount.credentialRevision,
        passwordRecoveryLockedAt: null,
      },
      data: { lastLoginAt: new Date() },
    });
    if (unchanged.count !== 1) {
      throw new LoginError(
        "TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH",
        "Der Sicherheitsstand des Kontos hat sich geändert",
        409,
      );
    }
    const sessionId = randomUUID();
    const nextToken = coreTokenService.issueToken({
      accountId: authenticatedAccount.id,
      loginName: authenticatedAccount.loginName,
      sessionId,
      source: "LOCAL",
      credentialRevision: authenticatedAccount.credentialRevision,
    });
    await transaction.session.create({
      data: {
        id: sessionId,
        accountId: authenticatedAccount.id,
        tokenHash: sessionTokenHash(nextToken),
        ipAddress: req.ip || null,
        userAgent: req.headers?.["user-agent"] || null,
        credentialRevision: authenticatedAccount.credentialRevision,
        mfaVerifiedAt: mfa?.verifiedAt || null,
        mfaProviderId: mfa?.providerId || null,
        mfaMethod: mfa?.method || null,
      },
    });
    return nextToken;
  });

  const shell = await createShell(authenticatedAccount);
  return {
    ok: true,
    token,
    accessToken: token,
    user: shell.identity,
    account: shell.identity,
    shell,
  };
}

async function getAccountFromRequest(req: any) {
  const accountId = req.user?.accountId || req.user?.id;
  if (!accountId) {
    return null;
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      person: {
        include: {
          member: true,
        },
      },
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      },
      accountMemberCapabilities: {
        include: {
          capability: true,
        },
      },
      authProvider: true,
    },
  });

  return account ? repairBootstrapAdminAccess(account) : null;
}

router.get("/status", async (_req, res) => {
  res.json({
    ok: true,
    coreAuth: true,
    service: "bonni-core-auth",
    checkedAt: new Date().toISOString(),
  });
});

router.post("/login", async (req, res) => {
  try {
    const loginName = normalizeLoginName(req.body?.login || req.body?.loginName || req.body?.username || req.body?.email);
    const passwordValidation = validateExactLocalPassword(req.body?.password);
    const password = passwordValidation.ok ? passwordValidation.password : "";

    if (!loginName || !passwordValidation.ok) {
      throw new LoginError("LOGIN_PAYLOAD_INVALID", "Benutzername und Passwort erforderlich", 400);
    }

    if (isForbiddenInteractiveLoginName(loginName)) {
      throw new LoginError(
        "LOGIN_NAME_FORBIDDEN",
        "Dieser Benutzername ist für Systemzwecke gesperrt",
        403,
      );
    }

    const account = await findAccountForLogin(loginName);
    if (!account) {
      throw new LoginError("ACCOUNT_NOT_FOUND", "Benutzer existiert nicht", 401);
    }

    if (!account.isActive) {
      throw new LoginError("ACCOUNT_DISABLED", "Benutzer deaktiviert", 403);
    }

    if (account.type === AccountType.SERVICE) {
      throw new LoginError(
        "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN",
        "Technische Dienstkonten dürfen sich nicht interaktiv anmelden",
        403,
      );
    }

    if (!account.passwordHash) {
      throw new LoginError("INVALID_PASSWORD", "Passwort falsch", 401);
    }

    const validPassword = await verifyPasswordRuntime(password, account.passwordHash);
    if (!validPassword) {
      throw new LoginError("INVALID_PASSWORD", "Passwort falsch", 401);
    }

    if (account.passwordRecoveryLockedAt) {
      throw new LoginError(
        "PASSWORD_RECOVERY_LOCKED",
        "Das Konto ist bis zum Abschluss der Wiederherstellung gesperrt",
        423,
      );
    }

    const authenticatedAccount = await repairBootstrapAdminAccess(account);
    if (await twoFactorService.hasActiveTwoFactor(authenticatedAccount.id)) {
      const challenge = await twoFactorService.createChallenge(
        authenticatedAccount.id,
        { purpose: "LOGIN" },
        requestMeta(req),
      );
      return res.status(202).json({
        ok: true,
        requiresTwoFactor: true,
        challenge,
        message: `Bitte die Zwei-Faktor-Authentifizierung (2FA) über ${challenge.providerLabel || "Bonni"} abschließen.`,
      });
    }

    return res.json(await completeInteractiveLogin(authenticatedAccount, req));
  } catch (error: unknown) {
    const normalized = normalizeLoginError(error);
    res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
});

router.post("/login/2fa", async (req, res) => {
  try {
    const challengeId = String(req.body?.challengeId || "").trim();
    const code = exactOptionalProofText(req.body?.code, "code", 128);
    const recoveryCode = exactOptionalProofText(req.body?.recoveryCode, "recoveryCode", 80);
    const token = exactOptionalProofText(req.body?.token, "token", 128);
    const passwordValidation = req.body?.password === undefined
      ? null
      : validateExactLocalPassword(req.body.password);
    const password = passwordValidation?.ok ? passwordValidation.password : undefined;
    if (
      !challengeId
      || (code === undefined && recoveryCode === undefined && token === undefined && password === undefined)
      || (passwordValidation !== null && !passwordValidation.ok)
    ) {
      throw Object.assign(new Error("TWO_FACTOR_LOGIN_PAYLOAD_INVALID"), {
        code: "TWO_FACTOR_LOGIN_PAYLOAD_INVALID",
        statusCode: 400,
      });
    }

    const pending = await prisma.securityTwoFactorChallenge.findUnique({
      where: { id: challengeId },
      select: { accountId: true, purpose: true },
    });
    const pendingAccount = pending?.purpose === "LOGIN"
      ? await prisma.account.findUnique({ where: { id: pending.accountId }, select: { passwordRecoveryLockedAt: true } })
      : null;
    if (pendingAccount?.passwordRecoveryLockedAt) {
      throw new LoginError("PASSWORD_RECOVERY_LOCKED", "Das Konto ist bis zum Abschluss der Wiederherstellung gesperrt", 423);
    }

    const verified = await twoFactorService.verifyLoginChallenge(
      challengeId,
      {
        code,
        recoveryCode,
        token,
        password,
      },
      requestMeta(req),
    );
    const consumed = await twoFactorService.consumeVerifiedChallenge({
      accountId: verified.accountId,
      challengeId,
      purpose: "LOGIN",
    });

    const account = await findAccountForLoginById(verified.accountId);
    if (
      !account?.isActive
      || Boolean(account.passwordRecoveryLockedAt)
      || account.type === AccountType.SERVICE
      || account.credentialRevision !== consumed.credentialRevision
    ) {
      throw new LoginError("ACCOUNT_DISABLED", "Benutzer deaktiviert", 403);
    }
    return res.json(await completeInteractiveLogin(
      account,
      req,
      consumed.credentialRevision,
      {
        verifiedAt: consumed.verifiedAt as Date,
        providerId: consumed.providerId,
        method: consumed.method,
      },
    ));
  } catch (error: unknown) {
    const normalized = normalizeLoginError(error);
    return res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
      details: (error as any)?.details,
    });
  }
});

router.post("/logout", async (req: any, res) => {
  try {
    const sessionId = String(req.bonniSessionId || "").trim();
    const accountId = String(req.user?.accountId || req.user?.id || "").trim();
    if (sessionId && accountId) {
      await prisma.session.updateMany({
        where: {
          id: sessionId,
          accountId,
          endedAt: null,
        },
        data: { endedAt: new Date() },
      });
    }
    return res.json({ ok: true });
  } catch (error: unknown) {
    const normalized = normalizeLoginError(error);
    return res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
});

router.post("/heartbeat", (req, res) => {
  res.json({
    ok: true,
    authenticated: Boolean((req as any).user),
    checkedAt: new Date().toISOString(),
  });
});

router.get("/me", async (req, res) => {
  try {
    const account = await getAccountFromRequest(req);
    if (!account) {
      return res.status(401).json({
        code: "UNAUTHENTICATED",
        message: "Nicht angemeldet",
      });
    }

    const shell = await createShell(account);
    return res.json(shell.identity);
  } catch (error) {
    const normalized = normalizeLoginError(error);
    return res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
});

async function shellHandler(req: any, res: any) {
  try {
    const account = await getAccountFromRequest(req);
    if (!account) {
      return res.status(401).json({
        code: "UNAUTHENTICATED",
        message: "Nicht angemeldet",
      });
    }

    return res.json(await createShell(account));
  } catch (error) {
    const normalized = normalizeLoginError(error);
    return res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
}

router.get("/shell", shellHandler);
router.post("/shell", shellHandler);

export default router;
