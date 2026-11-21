import { authConfig } from "../../../../core/config/auth.config.js";
export function getLocalAuthProviderStatus() {
    return {
        id: "local",
        enabled: true,
        alwaysAvailable: true,
        purpose: authConfig.local.purpose,
        bind: authConfig.local.bind,
        port: authConfig.local.port
    };
}
