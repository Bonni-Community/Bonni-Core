import { env } from "./env.js";
export const authConfig = {
    mode: env.AUTH_MODE,
    jwtSecret: env.JWT_SECRET,
    local: {
        enabled: true,
        purpose: ["sandbox", "emergency", "development", "technical-admin"],
        bind: env.LOCAL_AUTH_BIND,
        port: env.LOCAL_AUTH_PORT
    },
    oidc: {
        enabled: env.OIDC_ENABLED,
        port: env.PORT,
        issuerUrl: env.OIDC_ISSUER_URL,
        clientId: env.OIDC_CLIENT_ID,
        redirectUri: env.OIDC_REDIRECT_URI,
        postLogoutRedirectUri: env.OIDC_POST_LOGOUT_REDIRECT_URI
    }
};
