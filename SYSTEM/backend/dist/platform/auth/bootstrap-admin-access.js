function normalized(value) {
    return String(value || "").trim().toLowerCase();
}
export function isLocalBootstrapAdmin(account) {
    if (!account?.isActive || account.isSandbox || String(account.type).toUpperCase() !== "ADMIN") {
        return false;
    }
    const loginName = normalized(account.loginName);
    const providerKey = normalized(account.authProvider?.key);
    return providerKey === "local" && ["admin", "administrator"].includes(loginName);
}
function hasCanonicalAdminAccess(account) {
    const roles = Array.isArray(account.roles) ? account.roles : [];
    const roleKeys = roles.map((entry) => normalized(entry?.role?.key));
    const permissionKeys = roles.flatMap((entry) => (Array.isArray(entry?.role?.permissions)
        ? entry.role.permissions.map((permissionEntry) => normalized(permissionEntry?.permission?.key))
        : []));
    const hasAdminRole = roleKeys.some((key) => ["admin", "system_admin", "system.admin"].includes(key));
    const hasSystemPermission = permissionKeys.some((key) => ["*", "system.admin", "system_admin"].includes(key));
    return hasAdminRole && hasSystemPermission;
}
/**
 * Repairs only the canonical local bootstrap administrator. Older recovery
 * scripts created this account with type ADMIN but without its role links.
 * Ordinary accounts -- including other accounts with type ADMIN -- are never
 * promoted by this compatibility repair.
 */
export async function ensureLocalBootstrapAdminAccess(prisma, account) {
    if (!account || !isLocalBootstrapAdmin(account) || hasCanonicalAdminAccess(account)) {
        return false;
    }
    await prisma.$transaction(async (transaction) => {
        const permission = await transaction.permission.upsert({
            where: { key: "system.admin" },
            update: { label: "system.admin" },
            create: { key: "system.admin", label: "system.admin" },
        });
        const role = await transaction.role.upsert({
            where: { key: "admin" },
            update: { label: "Administrator" },
            create: { key: "admin", label: "Administrator" },
        });
        await transaction.rolePermission.upsert({
            where: {
                roleId_permissionId: {
                    roleId: role.id,
                    permissionId: permission.id,
                },
            },
            update: {},
            create: {
                roleId: role.id,
                permissionId: permission.id,
            },
        });
        await transaction.accountRole.upsert({
            where: {
                accountId_roleId: {
                    accountId: account.id,
                    roleId: role.id,
                },
            },
            update: {},
            create: {
                accountId: account.id,
                roleId: role.id,
            },
        });
    });
    return true;
}
