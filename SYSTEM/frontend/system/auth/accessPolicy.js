const APP_ROUTE_ALIASES = {
  controlcenter: "control-center",
  "control-center": "control-center",
};

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function accessSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^app/, "");
}

export function normalizeLaunchTarget(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return null;

  const withoutHash = rawValue.replace(/^.*#\/?/, "");
  const withoutQuery = withoutHash.split("?")[0];
  const segments = withoutQuery.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const candidate = String(segments.at(-1) || withoutQuery).trim().toLowerCase();

  if (candidate.startsWith("app.")) return candidate;
  if (candidate.startsWith("app-") && candidate.length > 4) {
    return `app.${candidate.slice(4).replace(/-/g, "")}`;
  }

  return APP_ROUTE_ALIASES[candidate] || null;
}

function normalizeAppTarget(value) {
  const normalized = normalizeLaunchTarget(value);
  if (normalized?.startsWith("app.")) return normalized;

  const slug = accessSlug(value);
  return slug ? `app.${slug}` : null;
}

function normalizeAccessKind(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");

  if (["control-center", "control center", "controlcenter", "control"].includes(normalized)) {
    return "control-center";
  }
  if (normalized === "app") return "app";
  return null;
}

function canonicalAccessRoleParts(value) {
  const raw = String(value || "").trim().toLowerCase();
  const parts = raw.startsWith("access:") ? raw.split(":") : [];
  if (parts.length !== 4) return null;
  if (!/^[a-z0-9-]+$/.test(parts[1]) || !/^[a-z0-9-]+$/.test(parts[2]) || !/^[a-z0-9-]+$/.test(parts[3])) {
    return null;
  }
  return parts;
}

function targetFromAccessEntry(entry) {
  const kind = normalizeAccessKind(entry?.kind);
  if (kind === "control-center") return "control-center";
  if (kind !== "app") return null;

  return normalizeAppTarget(entry?.moduleKey || entry?.key || entry?.moduleName || entry?.name);
}

function targetsFromRoles(user, shell) {
  const roles = [
    ...asList(user?.roles),
    ...asList(user?.permissions?.roles),
    ...asList(shell?.identity?.roles),
    ...asList(shell?.permissions?.roles),
  ];

  return roles.flatMap((role) => {
    const rawRole = String(role?.key || role?.label || role || "").trim();
    const normalizedRole = rawRole.toLowerCase();

    if (["admin", "administrator", "system_admin", "system.admin"].includes(normalizedRole)) {
      return ["control-center"];
    }

    const keyParts = canonicalAccessRoleParts(normalizedRole);
    if (!keyParts) return [];

    const keyKind = normalizeAccessKind(keyParts[1]);
    if (keyKind === "control-center") return ["control-center"];
    if (keyKind === "app") {
      const target = normalizeAppTarget(keyParts[2]);
      return target ? [target] : [];
    }

    return [];
  });
}

function permissionValues(user, shell) {
  return [
    ...asList(user?.permissions),
    ...asList(user?.permissions?.permissions),
    ...asList(shell?.identity?.permissions),
    ...asList(shell?.permissions?.permissions),
  ].map((entry) => String(entry?.key || entry || "").trim()).filter(Boolean);
}

function uniqueTargets(values) {
  return [...new Set(values.map(normalizeLaunchTarget).filter(Boolean))];
}

function moduleAccessEntries(user, shell) {
  return [
    ...asList(user?.moduleAccess),
    ...asList(user?.permissions?.moduleAccess),
    ...asList(shell?.identity?.moduleAccess),
    ...asList(shell?.permissions?.moduleAccess),
  ];
}

export function getAssignedTargets(user, shell) {
  const moduleAccess = moduleAccessEntries(user, shell);

  return uniqueTargets([
    ...moduleAccess.map(targetFromAccessEntry),
    ...targetsFromRoles(user, shell),
    ...asList(user?.allowedApps),
    ...asList(shell?.identity?.allowedApps),
    ...asList(shell?.permissions?.allowedApps),
  ]);
}

function normalizeWorkspace(value) {
  const workspace = String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!workspace) return null;
  if (["ADMIN", "ADMINISTRATOR", "SYSTEM_ADMIN"].includes(workspace)) return "ADMIN";
  if (["MEMBER", "MITGLIED"].includes(workspace)) return "MEMBER";
  return workspace;
}

function workspaceFromPermission(value) {
  return normalizeWorkspace(
    String(value || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "_"),
  );
}

function workspaceFromRoles(target, user, shell) {
  const roles = [
    ...asList(user?.roles),
    ...asList(user?.permissions?.roles),
    ...asList(shell?.identity?.roles),
    ...asList(shell?.permissions?.roles),
  ];

  for (const role of roles) {
    const rawRole = String(role?.key || role?.label || role || "").trim();
    const keyParts = canonicalAccessRoleParts(rawRole);
    if (
      keyParts
      &&
      normalizeAccessKind(keyParts[1]) === "app"
      && normalizeAppTarget(keyParts[2]) === target
    ) {
      const workspace = workspaceFromPermission(keyParts[3]);
      if (workspace) return workspace;
    }

  }

  return null;
}

export function getWorkspaceForLaunchTarget(target, user, shell) {
  const normalizedTarget = normalizeLaunchTarget(target);
  if (!normalizedTarget?.startsWith("app.")) return null;
  if (!canOpenLaunchTarget(normalizedTarget, user, shell)) return null;

  const matchingAccess = moduleAccessEntries(user, shell)
    .filter((entry) => targetFromAccessEntry(entry) === normalizedTarget);
  const accessWorkspace = matchingAccess.flatMap((entry) => [
    entry?.workspace,
    ...asList(entry?.permissions),
  ]).map(workspaceFromPermission).find(Boolean);
  if (accessWorkspace) return accessWorkspace;

  const navigation = [
    ...asList(shell?.permissions?.navigation),
    ...asList(shell?.navigation),
  ];
  const navigationWorkspace = navigation
    .filter((entry) => normalizeLaunchTarget(entry?.appRoute || entry?.route || entry?.key) === normalizedTarget)
    .map((entry) => normalizeWorkspace(entry?.workspace))
    .find(Boolean);
  if (navigationWorkspace) return navigationWorkspace;

  const roleWorkspace = workspaceFromRoles(normalizedTarget, user, shell);
  if (roleWorkspace) return roleWorkspace;

  const configuredWorkspace = [
    shell?.permissions?.defaultWorkspace,
    shell?.identity?.defaultWorkspace,
    user?.defaultWorkspace,
    ...asList(shell?.permissions?.allowedWorkspaces),
    ...asList(shell?.identity?.allowedWorkspaces),
    ...asList(user?.allowedWorkspaces),
  ].map(normalizeWorkspace).find((workspace) => workspace && workspace !== "ADMIN");

  return configuredWorkspace || "MEMBER";
}

function permissionKeys(user, shell) {
  return permissionValues(user, shell).map((permission) => permission.toLowerCase());
}

function roleKeys(user, shell) {
  return [
    ...asList(user?.roles),
    ...asList(user?.permissions?.roles),
    ...asList(shell?.identity?.roles),
    ...asList(shell?.permissions?.roles),
  ].map((role) => String(typeof role === "string" ? role : role?.key || "").trim().toUpperCase());
}

export function canOpenControlCenter(user, shell) {
  const assignedTargets = getAssignedTargets(user, shell);
  if (assignedTargets.includes("control-center")) return true;

  return permissionKeys(user, shell).some((permission) => (
    ["*", "system.admin", "system_admin"].includes(permission)
  ));
}

export function hasSystemAdministratorAccess(user, shell) {
  const administratorRole = roleKeys(user, shell).some((role) => (
    ["ADMIN", "SYSTEM_ADMIN", "SYSTEM.ADMIN"].includes(role)
  ));
  if (administratorRole) return true;

  return permissionKeys(user, shell).some((permission) => (
    permission === "*" || permission.replace(/_/g, ".") === "system.admin"
  ));
}

export function canOpenSystemUpdate(user, shell) {
  return hasSystemAdministratorAccess(user, shell);
}

export function canOpenLaunchTarget(target, user, shell) {
  const normalized = normalizeLaunchTarget(target);
  if (!normalized) return false;
  if (normalized === "control-center") return canOpenControlCenter(user, shell);

  return getAssignedTargets(user, shell).includes(normalized);
}

function isTerminalIdentity(user, shell) {
  return [user?.type, shell?.identity?.type]
    .some((value) => String(value || "").trim().toUpperCase() === "TERMINAL");
}

export function getLaunchTarget(user, shell) {
  const assignedApps = getAssignedTargets(user, shell)
    .filter((target) => target.startsWith("app."));

  // Persönliche Benutzer starten immer im Bonni-Kreis. Erst die Auswahl eines
  // freigeschalteten Segments öffnet die jeweilige App im Memberbereich.
  if (!isTerminalIdentity(user, shell)) return "home";

  const configuredDefault = [
    shell?.permissions?.defaultApp,
    shell?.permissions?.defaultModule,
    shell?.identity?.defaultApp,
    shell?.app?.defaultKey,
    shell?.permissions?.defaultRoute,
    shell?.identity?.defaultRoute,
    shell?.app?.defaultRoute,
    user?.defaultApp,
    user?.defaultRoute,
  ].map(normalizeLaunchTarget).find((target) => canOpenLaunchTarget(target, user, shell));

  if (configuredDefault) return configuredDefault;

  if (assignedApps.length === 1) return assignedApps[0];
  if (assignedApps.length > 1) return "home";

  return "home";
}
