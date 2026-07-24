import { Router } from "express";
import { AccountType, PrismaClient } from "@prisma/client";

import { LoginError, normalizeLoginError } from "../../../core/errors/login-error.js";
import { listModuleManifests } from "../../module-manager/manifests/index.js";
import type { ModuleManifestSummary } from "../../module-manager/types.js";
import { ensureLocalBootstrapAdminAccess } from "../bootstrap-admin-access.js";
import { verifyPasswordRuntime } from "../password-runtime.js";
import { coreTokenService } from "../token/core-token.service.js";

const router = Router();
const prisma = new PrismaClient();

type AccountWithAuth = Awaited<ReturnType<typeof findAccountForLogin>>;

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
  if (["BAR", "BARKEEPER", "BARTENDER", "THEKE"].includes(permission)) return "BAR";
  if (["KITCHEN", "KUECHE", "KUCHE", "KOCH", "COOK"].includes(permission)) return "KITCHEN";
  if (["TABLE", "TABLES", "TABLEBS", "TISCH", "FENSTER", "TERMINAL"].includes(permission)) return "TABLE";
  if ([
    "MEMBER",
    "MITGLIED",
    "MANAGER",
    "STOREMAN",
    "TREASURER",
    "HELPER",
    "WAREHOUSE",
    "LAGER",
    "ACCOUNTING",
    "CASHIER",
    "KASSE",
  ].includes(permission)) return "MEMBER";

  return null;
}

function workspaceForAssignmentPermission(
  assignment: Pick<ModuleAccessSummary, "kind">,
  value: unknown,
) {
  const workspace = workspaceForPermission(value);

  // "Administrator" inside an app is an app function. It must never route a
  // user into the Bonni Core Control Center workspace.
  if (assignment.kind === "app" && workspace === "ADMIN") return "MEMBER";

  return workspace;
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

    return {
      ...assignment,
      moduleKey,
      moduleName,
      appRoute,
      route,
      manifestRoute,
      workspace: unique(
        assignment.permissions.map((permission) => workspaceForAssignmentPermission(assignment, permission)),
      )[0] || null,
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
    assignment.permissions.map((permission) => workspaceForAssignmentPermission(assignment, permission))
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
    const password = String(req.body?.password || "");

    if (!loginName || !password) {
      throw new LoginError("LOGIN_PAYLOAD_INVALID", "Benutzername und Passwort erforderlich", 400);
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

    const authenticatedAccount = await repairBootstrapAdminAccess(account);

    const token = coreTokenService.issueToken({
      accountId: authenticatedAccount.id,
      loginName: authenticatedAccount.loginName,
      source: "LOCAL",
    });

    await prisma.account.update({
      where: { id: authenticatedAccount.id },
      data: { lastLoginAt: new Date() },
    });

    await prisma.session.create({
      data: {
        accountId: authenticatedAccount.id,
        tokenHash: null,
        ipAddress: req.ip || null,
        userAgent: req.headers?.["user-agent"] || null,
      },
    }).catch(() => null);

    const shell = await createShell(authenticatedAccount);

    res.json({
      ok: true,
      token,
      accessToken: token,
      user: shell.identity,
      account: shell.identity,
      shell,
    });
  } catch (error: unknown) {
    const normalized = normalizeLoginError(error);
    res.status(normalized.status).json({
      code: normalized.code,
      message: normalized.message,
    });
  }
});

router.post("/login/2fa", (_req, res) => {
  res.status(501).json({
    code: "TWO_FACTOR_NOT_CONFIGURED",
    message: "2FA ist im Bonni-Core-Basislogin noch nicht aktiv.",
  });
});

router.post("/logout", (_req, res) => {
  res.json({ ok: true });
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
