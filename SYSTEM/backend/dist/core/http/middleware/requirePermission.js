function normalizePermissionVariants(permissionKey) {
    const raw = String(permissionKey || "").trim();
    const lower = raw.toLowerCase();
    const upper = raw.toUpperCase();
    return new Set([
        raw,
        lower,
        upper,
        lower.replace(/_/g, "."),
        lower.replace(/\./g, "_"),
        upper.replace(/\./g, "_"),
        upper.replace(/_/g, "."),
    ]);
}
function hasRequiredPermission(availablePermissions, requiredPermission) {
    const requiredVariants = normalizePermissionVariants(requiredPermission);
    return availablePermissions.some((permission) => {
        if (String(permission || "").trim() === "*")
            return true;
        const availableVariants = normalizePermissionVariants(permission);
        return [...availableVariants].some((variant) => requiredVariants.has(variant));
    });
}
function hasAdministratorRole(roles) {
    const roleKeys = roles
        .map((role) => String(role || "").trim().toUpperCase())
        .filter(Boolean);
    return roleKeys.includes("ADMIN")
        || roleKeys.includes("SYSTEM_ADMIN")
        || roleKeys.includes("SYSTEM.ADMIN");
}
export function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ error: "AUTH_REQUIRED" });
        }
        const permissions = Array.isArray(req.auth.permissions) ? req.auth.permissions : [];
        const roles = Array.isArray(req.auth.roles) ? req.auth.roles : [];
        // Setup und Altinstallationen verwenden den kanonischen DB-Schluessel
        // `system.admin`, waehrend einige Core-Routen historisch `SYSTEM_ADMIN`
        // anfordern. Beide Schreibweisen muessen dieselbe Berechtigung bedeuten.
        if (!hasAdministratorRole(roles) && !hasRequiredPermission(permissions, permission)) {
            return res.status(403).json({
                error: "PERMISSION_DENIED",
                permission
            });
        }
        next();
    };
}
