export { twoFactorRouter } from "./routes/two-factor.routes.js";
export * as twoFactorService from "./services/two-factor.service.js";
export { verifyLoginTwoFactorSchema } from "./schemas/two-factor.schemas.js";
export { createModuleTwoFactorRuntime, MODULE_TWO_FACTOR_CONTRACT_VERSION, } from "./module-two-factor-runtime.js";
export { createStagedModuleTwoFactorProviderRuntime, TWO_FACTOR_PROVIDER_CONTRACT_VERSION, } from "./two-factor-provider-registry.js";
// Kompatibilitaetsoberflaeche: fachliche Ownership bleibt im Core-Modul.
// Der Export sorgt dafuer, dass der bisherige Runtime-Pfad weiter gebaut wird.
export * from "./services/totp.js";
