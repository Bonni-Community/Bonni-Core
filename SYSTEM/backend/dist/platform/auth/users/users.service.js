import { getPrismaClient } from "../../../core/database/database.js";
const EMPTY_RESPONSE = {
    ok: false,
    area: "user",
    status: "error",
    checkedAt: new Date(0).toISOString(),
    message: "Benutzerdaten konnten nicht geladen werden.",
    stats: {
        members: 0,
        activeMembers: 0,
        accounts: 0,
        activeAccounts: 0,
        activeSessions: 0,
        terminalSessions: 0,
        roles: 0,
        invitations: 0,
        technicalAccounts: 0,
        localAccounts: 0,
        oidcAccounts: 0,
        oidcActive: false,
        oidcLastUpdatedAt: null,
    },
    filters: {
        roles: [],
        statuses: ["Aktiviert", "Deaktiviert"],
    },
    members: [],
    users: [],
};
function toNumber(value, fallback = 0) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "bigint")
        return Number(value);
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}
function asIsoDate(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function parseJsonArray(value) {
    if (Array.isArray(value))
        return value.filter(Boolean);
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
function getInitials(input) {
    const parts = String(input || "")
        .trim()
        .split(/[\s._-]+/)
        .filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return (parts[0] || "?").slice(0, 2).toUpperCase();
}
function roleTone(label) {
    const normalized = label.toLowerCase();
    if (normalized.includes("admin"))
        return "red";
    if (normalized.includes("system") || normalized.includes("verwaltung"))
        return "blue";
    if (normalized.includes("terminal") || normalized.includes("service"))
        return "orange";
    if (normalized.includes("member") || normalized.includes("mitglied") || normalized.includes("benutzer"))
        return "green";
    return "gray";
}
function normalizeLabel(value, fallback = "Ohne Rolle") {
    if (typeof value === "string" && value.trim())
        return value.trim();
    return fallback;
}
function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "de"));
}
function uniqueInOrder(values) {
    return [...new Set(values.filter(Boolean))];
}
function accessSlug(value, fallback = "modul") {
    const normalized = String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || fallback;
}
function normalizeModuleAccessKind(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (["control-center", "control center", "controlcenter", "control"].includes(normalized))
        return "control-center";
    if (normalized === "app")
        return "app";
    if (["add-on", "addon"].includes(normalized))
        return "add-on";
    if (["plug-in", "plugin"].includes(normalized))
        return "plug-in";
    return null;
}
function mergeModuleAccess(assignments) {
    const grouped = new Map();
    assignments.forEach((assignment) => {
        const key = `${assignment.kind}:${assignment.moduleKey}:${assignment.moduleName}`;
        const current = grouped.get(key);
        if (current) {
            current.permissions = uniqueInOrder([...current.permissions, ...assignment.permissions]);
            return;
        }
        grouped.set(key, {
            ...assignment,
            permissions: uniqueInOrder(assignment.permissions),
        });
    });
    return [...grouped.values()];
}
function moduleAccessFromRoles(roleEntries) {
    const assignments = roleEntries.flatMap((role) => {
        const roleKey = String(role?.key || "").trim();
        const roleLabel = String(role?.label || roleKey).trim();
        const normalizedRoleKey = roleKey.toLowerCase();
        if (normalizedRoleKey === "admin" || roleLabel.toLowerCase() === "administrator") {
            return [{
                    kind: "control-center",
                    moduleKey: "control-center",
                    moduleName: "Control Center",
                    permissions: ["Administrator"],
                }];
        }
        const labelMatch = roleLabel.match(/^(Control Center|App|Add-on|Plug-in)\s*:\s*(.*?)\s*·\s*(.+)$/i);
        const keyParts = normalizedRoleKey.startsWith("access:") ? roleKey.split(":") : [];
        const kind = normalizeModuleAccessKind(labelMatch?.[1] || keyParts[1]);
        const moduleName = String(labelMatch?.[2] || "").trim();
        const permission = String(labelMatch?.[3] || "").trim();
        if (!kind || !moduleName || !permission)
            return [];
        return [{
                kind,
                moduleKey: String(keyParts[2] || accessSlug(moduleName)).trim(),
                moduleName,
                permissions: [permission],
            }];
    });
    return mergeModuleAccess(assignments);
}
const ROLE_LABELS = {
    admin: "Administrator",
    administrator: "Administrator",
    system_admin: "Administrator",
    member: "Member",
    mitglied: "Member",
    system: "System",
};
const ACCESS_ORDER = [
    "Administrator",
    "Member",
    "System",
];
function normalizeAccessLabel(value, fallback = "Ohne Rolle") {
    const label = normalizeLabel(value, fallback);
    const key = label
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return ROLE_LABELS[key] || label;
}
function orderAccessLabels(values) {
    const unique = uniqueInOrder(values.map((value) => normalizeAccessLabel(value, "")).filter(Boolean));
    return unique.sort((left, right) => {
        const leftIndex = ACCESS_ORDER.indexOf(left);
        const rightIndex = ACCESS_ORDER.indexOf(right);
        if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
        }
        return left.localeCompare(right, "de");
    });
}
function hasAnyAccessLabel(labels, wanted) {
    const normalized = labels.map((label) => normalizeAccessLabel(label, ""));
    return wanted.some((item) => normalized.includes(item));
}
export function isTechnicalAccessAccount(account) {
    const type = String(account.type || "").toUpperCase();
    if (["TERMINAL", "SERVICE"].includes(type))
        return true;
    if (String(account.usageLabel || "").toLowerCase().includes("techn"))
        return true;
    return false;
}
async function safeQuery(label, runner, fallback) {
    try {
        return await runner();
    }
    catch (error) {
        console.warn(`[system/user] ${label} konnte nicht geladen werden`, error);
        return fallback;
    }
}
async function queryMembers(prisma) {
    return safeQuery("MemberProfile/Person", () => prisma.$queryRawUnsafe(`
      SELECT
        m."id" AS "memberId",
        m."memberNumber" AS "memberNumber",
        m."status"::text AS "memberStatus",
        m."membershipStatus"::text AS "membershipStatus",
        p."id" AS "personId",
        p."displayName" AS "displayName",
        p."firstName" AS "firstName",
        p."lastName" AS "lastName",
        p."nickname" AS "nickname",
        p."email" AS "email",
        p."phone" AS "phone",
        p."birthDate" AS "birthDate",
        m."joinedAt" AS "joinedAt",
        m."leftAt" AS "leftAt",
        m."createdAt" AS "createdAt",
        m."updatedAt" AS "updatedAt"
      FROM "MemberProfile" m
      INNER JOIN "Person" p ON p."id" = m."personId"
      ORDER BY lower(COALESCE(p."displayName", p."lastName", p."firstName", m."id")) ASC
    `), []);
}
async function queryAccounts(prisma) {
    const fullRows = await safeQuery("Account mit Provider/Rollen/Funktionen", () => prisma.$queryRawUnsafe(`
      SELECT
        a."id" AS "accountId",
        a."personId" AS "personId",
        p."displayName" AS "personDisplayName",
        a."type"::text AS "accountType",
        a."loginName" AS "loginName",
        a."email" AS "email",
        a."isActive" AS "isActive",
        a."isSandbox" AS "isSandbox",
        CASE
          WHEN a."lastLoginAt" IS NULL THEN MAX(s."startedAt")
          WHEN MAX(s."startedAt") IS NULL THEN a."lastLoginAt"
          WHEN a."lastLoginAt" >= MAX(s."startedAt") THEN a."lastLoginAt"
          ELSE MAX(s."startedAt")
        END AS "lastLoginAt",
        a."createdAt" AS "createdAt",
        a."authProviderId" AS "authProviderId",
        ap."key" AS "authProviderKey",
        ap."type"::text AS "authProviderType",
        ap."name" AS "authProviderName",
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('key', r."key", 'label', r."label"))
            FILTER (WHERE r."id" IS NOT NULL),
          '[]'::jsonb
        ) AS "roles",
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('key', c."key"::text, 'label', c."label"))
            FILTER (WHERE c."id" IS NOT NULL),
          '[]'::jsonb
        ) AS "capabilities"
      FROM "Account" a
      LEFT JOIN "Person" p ON p."id" = a."personId"
      LEFT JOIN "AuthProvider" ap ON ap."id" = a."authProviderId"
      LEFT JOIN "AccountRole" ar ON ar."accountId" = a."id"
      LEFT JOIN "Role" r ON r."id" = ar."roleId"
      LEFT JOIN "AccountMemberCapability" ac ON ac."accountId" = a."id"
      LEFT JOIN "MemberCapability" c ON c."id" = ac."capabilityId"
      LEFT JOIN "Session" s ON s."accountId" = a."id"
      GROUP BY a."id", ap."id", p."id"
      ORDER BY lower(a."loginName") ASC
    `), null);
    if (fullRows)
        return fullRows;
    return safeQuery("Account Basisdaten", () => prisma.$queryRawUnsafe(`
      SELECT
        a."id" AS "accountId",
        a."personId" AS "personId",
        p."displayName" AS "personDisplayName",
        a."type"::text AS "accountType",
        a."loginName" AS "loginName",
        a."email" AS "email",
        a."isActive" AS "isActive",
        a."isSandbox" AS "isSandbox",
        CASE
          WHEN a."lastLoginAt" IS NULL THEN MAX(s."startedAt")
          WHEN MAX(s."startedAt") IS NULL THEN a."lastLoginAt"
          WHEN a."lastLoginAt" >= MAX(s."startedAt") THEN a."lastLoginAt"
          ELSE MAX(s."startedAt")
        END AS "lastLoginAt",
        a."createdAt" AS "createdAt",
        a."authProviderId" AS "authProviderId",
        NULL::text AS "authProviderKey",
        NULL::text AS "authProviderType",
        NULL::text AS "authProviderName",
        '[]'::jsonb AS "roles",
        '[]'::jsonb AS "capabilities"
      FROM "Account" a
      LEFT JOIN "Person" p ON p."id" = a."personId"
      LEFT JOIN "Session" s ON s."accountId" = a."id"
      GROUP BY a."id", p."id"
      ORDER BY lower(a."loginName") ASC
    `), []);
}
async function getActiveSessionsByAccount(prisma) {
    const rows = await safeQuery("aktive Account-Sessions", () => prisma.$queryRawUnsafe(`
      SELECT "accountId" AS "id", COUNT(*)::int AS "count"
      FROM "Session"
      WHERE "endedAt" IS NULL
      GROUP BY "accountId"
    `), []);
    return new Map(rows.map((row) => [String(row.id), toNumber(row.count, 0)]));
}
async function getActiveTerminalSessionsByPerson(prisma) {
    const rows = await safeQuery("aktive Terminal-Sessions", () => prisma.$queryRawUnsafe(`
      SELECT "personId" AS "id", COUNT(*)::int AS "count"
      FROM "TerminalSession"
      WHERE "endedAt" IS NULL AND "personId" IS NOT NULL
      GROUP BY "personId"
    `), []);
    return new Map(rows.map((row) => [String(row.id), toNumber(row.count, 0)]));
}
async function queryActiveTerminalSurfaces(prisma) {
    return safeQuery("aktive Terminal-Oberflächen", () => prisma.$queryRawUnsafe(`
      SELECT
        ts."personId" AS "personId",
        ts."accountId" AS "accountId",
        t."id" AS "terminalId",
        t."key" AS "terminalKey",
        t."name" AS "terminalName",
        t."type"::text AS "terminalType",
        t."layoutPreset" AS "layoutPreset",
        COUNT(*)::int AS "count"
      FROM "TerminalSession" ts
      LEFT JOIN "Terminal" t ON t."id" = ts."terminalId"
      WHERE ts."endedAt" IS NULL
      GROUP BY ts."personId", ts."accountId", t."id"
      ORDER BY lower(COALESCE(t."name", t."key", t."type"::text, 'Terminal')) ASC
    `), []);
}
function humanizeAccountType(value) {
    const normalized = String(value || "").toUpperCase();
    if (normalized === "ADMIN")
        return "Control Center";
    if (normalized === "TERMINAL")
        return "App";
    if (normalized === "SERVICE")
        return "Service";
    if (normalized === "MEMBER")
        return "App";
    return "Oberfläche";
}
function humanizeTerminalType(value) {
    const normalized = String(value || "").toUpperCase();
    if (normalized === "ADMIN")
        return "Admin-Terminal";
    const label = normalized
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1)}${part.slice(1).toLowerCase()}`)
        .join(" ");
    return label ? `${label}-Terminal` : "Terminal";
}
function surfaceFromAccessLabel(label) {
    const normalized = label.toLowerCase();
    if (normalized.startsWith("control center:"))
        return "Control Center";
    if (normalized.startsWith("add-on:") || normalized.startsWith("addon:"))
        return "Add-on";
    if (normalized.startsWith("plug-in:") || normalized.startsWith("plugin:"))
        return "Plug-in";
    if (normalized.startsWith("app:"))
        return "App";
    if (normalized.includes("admin") || normalized.includes("administrator"))
        return "Control Center";
    if (normalized.includes("member") || normalized.includes("mitglied"))
        return "App";
    if (normalized.includes("system"))
        return "App";
    return "";
}
function terminalSurfaceLabel(row) {
    const name = normalizeLabel(row.terminalName || row.terminalKey, "");
    const type = humanizeTerminalType(row.terminalType);
    if (name && name !== type)
        return `${name} · ${type}`;
    return type;
}
export function usageLabelForAccount(account, labels = []) {
    const accountType = String(account.accountType || "").toUpperCase();
    const providerType = String(account.authProviderType || "").toUpperCase();
    const providerKey = String(account.authProviderKey || "").toLowerCase();
    if (["SERVICE", "TERMINAL"].includes(accountType))
        return "Technischer Account";
    if (account.isSandbox)
        return "Technischer Account";
    if (providerType === "OIDC" || providerKey.includes("oidc"))
        return "OIDC";
    if (providerType === "LOCAL" || providerKey === "local" || !providerType)
        return "Lokal";
    return providerType || "Lokal";
}
function mapTerminalSurfaces(rows, by) {
    const mapped = new Map();
    for (const row of rows) {
        const key = row[by];
        if (!key)
            continue;
        const list = mapped.get(key) || [];
        list.push(terminalSurfaceLabel(row));
        mapped.set(key, uniqueSorted(list));
    }
    return mapped;
}
function normalizeAccount(account, activeSessionsByAccount, terminalSurfacesByAccount) {
    const roleEntries = parseJsonArray(account.roles);
    const moduleAccess = moduleAccessFromRoles(roleEntries);
    const roles = roleEntries
        .map((role) => normalizeAccessLabel(role.label || role.key, role.key || "Ohne Rolle"))
        .filter(Boolean);
    const capabilities = parseJsonArray(account.capabilities)
        .map((capability) => normalizeAccessLabel(capability.label || capability.key, capability.key || ""))
        .filter(Boolean);
    const standaloneCapabilities = capabilities.filter((capability) => {
        const normalizedCapability = capability.toLowerCase();
        return !roles.some((role) => {
            const normalizedRole = role.toLowerCase();
            return normalizedRole === normalizedCapability
                || normalizedRole.endsWith(`: ${normalizedCapability}`)
                || normalizedRole.endsWith(`· ${normalizedCapability}`);
        });
    });
    const labels = orderAccessLabels([...roles, ...standaloneCapabilities]);
    const surfaceLabels = uniqueSorted([
        ...labels.map(surfaceFromAccessLabel).filter(Boolean),
        ...(terminalSurfacesByAccount.get(account.accountId) || []),
        humanizeAccountType(account.accountType),
    ].filter((label) => label && label !== "Oberfläche"));
    const usageLabel = usageLabelForAccount(account, labels);
    const primaryRole = labels[0] || normalizeAccessLabel(account.accountType, "Account");
    return {
        accountId: account.accountId,
        id: account.accountId,
        personId: account.personId,
        displayName: account.personDisplayName || account.loginName || account.email || account.accountId,
        loginName: account.loginName || account.email || account.accountId,
        email: account.email || null,
        type: account.accountType || "ACCOUNT",
        providerId: account.authProviderId,
        providerKey: account.authProviderKey,
        providerType: account.authProviderType,
        providerName: account.authProviderName,
        usageLabel,
        usageLabels: [usageLabel],
        surfaceLabels,
        terminalLabels: terminalSurfacesByAccount.get(account.accountId) || [],
        isActive: Boolean(account.isActive),
        isSandbox: Boolean(account.isSandbox),
        status: account.isActive ? "Aktiviert" : "Deaktiviert",
        statusTone: account.isActive ? "active" : "inactive",
        roles,
        capabilities,
        accessLabels: labels,
        moduleAccess,
        role: primaryRole,
        roleTone: roleTone(primaryRole),
        activeSessions: activeSessionsByAccount.get(account.accountId) || 0,
        lastLoginAt: asIsoDate(account.lastLoginAt),
        createdAt: asIsoDate(account.createdAt),
    };
}
function normalizeMember(member, accounts, terminalSessionsByPerson, terminalSurfacesByPerson, index) {
    const displayName = member.displayName ||
        [member.firstName, member.lastName].filter(Boolean).join(" ").trim() ||
        member.nickname ||
        member.email ||
        member.memberNumber ||
        member.memberId;
    const activeAccounts = accounts.filter((account) => account.isActive);
    const activeSessions = accounts.reduce((sum, account) => sum + toNumber(account.activeSessions, 0), 0);
    const terminalSessions = terminalSessionsByPerson.get(member.personId) || 0;
    const allAccessLabels = orderAccessLabels(accounts.flatMap((account) => account.accessLabels || []));
    const usageLabels = uniqueSorted(accounts.flatMap((account) => account.usageLabels || []));
    const surfaceLabels = uniqueSorted([
        ...(terminalSurfacesByPerson.get(member.personId) || []),
        ...accounts.flatMap((account) => account.surfaceLabels || []),
    ]);
    const terminalLabels = uniqueSorted([
        ...(terminalSurfacesByPerson.get(member.personId) || []),
        ...accounts.flatMap((account) => account.terminalLabels || []),
    ]);
    const moduleAccess = mergeModuleAccess(accounts.flatMap((account) => account.moduleAccess || []));
    // Die Benutzerverwaltung zeigt ausschließlich den technischen Kontostatus.
    // Fachliche Profilstatus installierter Module dürfen niemals als
    // technischer Login-Status interpretiert werden.
    const primaryAccount = activeAccounts[0] || accounts[0] || null;
    const accountIsActive = Boolean(primaryAccount?.isActive);
    const status = accountIsActive ? "Aktiviert" : "Deaktiviert";
    return {
        id: member.memberId,
        rowNumber: index + 1,
        memberId: member.memberId,
        memberNumber: member.memberNumber,
        personId: member.personId,
        initials: getInitials(displayName),
        name: displayName,
        displayName,
        firstName: member.firstName,
        lastName: member.lastName,
        nickname: member.nickname,
        email: member.email || accounts.find((account) => account.email)?.email || "—",
        phone: member.phone,
        birthDate: asIsoDate(member.birthDate),
        status,
        statusTone: accountIsActive ? "active" : "inactive",
        memberStatus: member.memberStatus,
        membershipStatus: member.membershipStatus || "ACTIVE_MEMBER",
        joinedAt: asIsoDate(member.joinedAt),
        leftAt: asIsoDate(member.leftAt),
        createdAt: asIsoDate(member.createdAt),
        updatedAt: asIsoDate(member.updatedAt),
        accounts,
        accountCount: accounts.length,
        activeAccountCount: activeAccounts.length,
        activeSessions,
        terminalSessions,
        terminalLabels,
        surfaceLabels,
        usageLabels,
        lastLoginAt: accounts
            .map((account) => account.lastLoginAt)
            .filter(Boolean)
            .sort()
            .at(-1) || null,
        accessLabels: allAccessLabels,
        moduleAccess,
        role: allAccessLabels[0] || "Ohne Zugang",
        roles: allAccessLabels,
        roleTone: roleTone(allAccessLabels[0] || ""),
    };
}
function normalizeTechnicalAccount(account, rowNumber) {
    const displayName = account.displayName || account.loginName || account.accountId;
    const usageLabels = uniqueSorted(["Technischer Account", ...(account.usageLabels || [])]);
    return {
        id: `account:${account.accountId}`,
        rowNumber,
        memberId: null,
        memberNumber: null,
        personId: account.personId,
        initials: getInitials(displayName),
        name: displayName,
        displayName,
        email: account.email || "—",
        status: account.isActive ? "Aktiviert" : "Deaktiviert",
        statusTone: account.isActive ? "active" : "inactive",
        memberStatus: null,
        createdAt: account.createdAt,
        updatedAt: account.createdAt,
        accounts: [account],
        accountCount: 1,
        activeAccountCount: account.isActive ? 1 : 0,
        activeSessions: account.activeSessions,
        terminalSessions: 0,
        terminalLabels: account.terminalLabels || [],
        surfaceLabels: account.surfaceLabels || [],
        usageLabels,
        lastLoginAt: account.lastLoginAt,
        accessLabels: account.accessLabels || [],
        moduleAccess: account.moduleAccess || [],
        role: account.role || "Technischer Zugang",
        roles: account.accessLabels || [],
        roleTone: roleTone(account.role || account.type || ""),
        technicalOnly: true,
    };
}
async function markCurrentAccountActivity(prisma, currentUser, at) {
    const accountId = String(currentUser?.accountId || currentUser?.id || "").trim() || null;
    const loginName = String(currentUser?.loginName || "").trim().toLowerCase() || null;
    if (!accountId && !loginName) {
        return { accountId: null, loginName: null };
    }
    try {
        await prisma.account.updateMany({
            where: {
                OR: [
                    ...(accountId ? [{ id: accountId }] : []),
                    ...(loginName ? [{ loginName }] : []),
                ],
            },
            data: { lastLoginAt: at },
        });
    }
    catch (error) {
        console.warn("[system/user] aktuelle Anmeldung konnte nicht nachgetragen werden", error);
    }
    return { accountId, loginName };
}
function applyCurrentLoginFallback(accounts, marker, checkedAt) {
    if (!marker.accountId && !marker.loginName)
        return accounts;
    const checkedAtIso = checkedAt.toISOString();
    return accounts.map((account) => {
        const isCurrentAccount = (marker.accountId && account.accountId === marker.accountId) ||
            (marker.loginName && String(account.loginName || "").trim().toLowerCase() === marker.loginName);
        if (!isCurrentAccount)
            return account;
        return {
            ...account,
            activeSessions: Math.max(toNumber(account.activeSessions, 0), 1),
            lastLoginAt: account.lastLoginAt || checkedAtIso,
        };
    });
}
export async function getSystemUsersOverview(currentUser) {
    const checkedAt = new Date();
    try {
        const prisma = getPrismaClient();
        const currentAccountMarker = await markCurrentAccountActivity(prisma, currentUser, checkedAt);
        const [memberRows, accountRows, activeSessionsByAccount, terminalSessionsByPerson, terminalSurfaceRows,] = await Promise.all([
            queryMembers(prisma),
            queryAccounts(prisma),
            getActiveSessionsByAccount(prisma),
            getActiveTerminalSessionsByPerson(prisma),
            queryActiveTerminalSurfaces(prisma),
        ]);
        const terminalSurfacesByAccount = mapTerminalSurfaces(terminalSurfaceRows, "accountId");
        const terminalSurfacesByPerson = mapTerminalSurfaces(terminalSurfaceRows, "personId");
        const normalizedAccounts = applyCurrentLoginFallback(accountRows.map((account) => normalizeAccount(account, activeSessionsByAccount, terminalSurfacesByAccount)), currentAccountMarker, checkedAt);
        const accountsByPerson = new Map();
        const technicalAccounts = normalizedAccounts.filter((account) => isTechnicalAccessAccount(account));
        for (const account of normalizedAccounts) {
            if (!account.personId || isTechnicalAccessAccount(account))
                continue;
            const list = accountsByPerson.get(account.personId) || [];
            list.push(account);
            accountsByPerson.set(account.personId, list);
        }
        const technicalPersonIds = new Set(technicalAccounts.map((account) => account.personId).filter(Boolean));
        const members = memberRows
            .map((member, index) => normalizeMember(member, accountsByPerson.get(member.personId) || [], terminalSessionsByPerson, terminalSurfacesByPerson, index))
            .filter((member) => member.accountCount > 0 || !technicalPersonIds.has(member.personId));
        const technicalRows = technicalAccounts
            .map((account, index) => normalizeTechnicalAccount(account, members.length + index + 1));
        const rows = [...members, ...technicalRows];
        const activeMembers = rows.filter((member) => member.status === "Aktiviert").length;
        const activeAccounts = normalizedAccounts.filter((account) => account.isActive).length;
        const localAccounts = normalizedAccounts.filter((account) => account.usageLabel === "Lokal").length;
        const oidcAccounts = normalizedAccounts.filter((account) => account.usageLabel === "OIDC").length;
        const activeSessions = normalizedAccounts.reduce((sum, account) => sum + toNumber(account.activeSessions, 0), 0);
        const terminalSessions = rows.reduce((sum, row) => sum + toNumber(row.terminalSessions, 0), 0);
        const roleNames = uniqueSorted(rows.flatMap((row) => row.accessLabels || []));
        const usageNames = uniqueSorted(rows.flatMap((row) => row.usageLabels || []));
        const surfaceNames = uniqueSorted(rows.flatMap((row) => row.surfaceLabels || []));
        return {
            ok: true,
            area: "user",
            status: "live",
            checkedAt: checkedAt.toISOString(),
            model: {
                memberId: "Persönliche ID des Mitglieds / MemberProfile.id",
                accountId: "Zugangs-ID / Account.id; ein Mitglied kann mehrere Accounts besitzen",
                terminalContext: "Terminale wählen anhand AccountID/Rollen/Funktionen die passende Anzeige.",
                officialRoute: "/api/system/user",
            },
            stats: {
                members: rows.length,
                activeMembers,
                accounts: normalizedAccounts.length,
                activeAccounts,
                localAccounts,
                oidcAccounts,
                oidcActive: oidcAccounts > 0,
                oidcLastUpdatedAt: oidcAccounts > 0 ? checkedAt.toISOString() : null,
                activeSessions,
                terminalSessions,
                roles: roleNames.length,
                invitations: 0,
                technicalAccounts: technicalRows.length,
            },
            filters: {
                roles: roleNames,
                usages: usageNames,
                surfaces: surfaceNames,
                statuses: ["Aktiviert", "Deaktiviert"],
            },
            members: rows,
            users: rows,
            identityPolicy: {
                memberIdIsPersonalIdentity: true,
                accountIdIsAccessIdentity: true,
                memberCanHaveMultipleAccounts: true,
                terminalsResolveViewByAccount: true,
                officialEndpoint: "/api/system/user",
            },
        };
    }
    catch (error) {
        console.error("[system/user] Live-Daten konnten nicht geladen werden", error);
        return {
            ...EMPTY_RESPONSE,
            checkedAt: checkedAt.toISOString(),
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
