export function resolveBootstrapAdminPassword(configuredPassword) {
    if (!configuredPassword) {
        return {
            password: "hamster",
            replaceExistingPassword: false,
            usesStandardPassword: true,
        };
    }
    if (configuredPassword === "hamster") {
        return {
            password: configuredPassword,
            replaceExistingPassword: true,
            usesStandardPassword: true,
        };
    }
    const validation = validateExactLocalPassword(configuredPassword);
    if (!validation.ok
        || validation.characters < 16
        || !/[a-z]/.test(configuredPassword)
        || !/[A-Z]/.test(configuredPassword)
        || !/[0-9]/.test(configuredPassword)
        || !/[^A-Za-z0-9]/.test(configuredPassword)
        || /(change[-_ ]?me|password|passwort|admin|default|example)/i.test(configuredPassword)) {
        throw new Error("BONNI_BOOTSTRAP_ADMIN_PASSWORD_WEAK");
    }
    return {
        password: configuredPassword,
        replaceExistingPassword: true,
        usesStandardPassword: false,
    };
}
import { validateExactLocalPassword } from "../../core/modules/identity/local-password-policy.js";
