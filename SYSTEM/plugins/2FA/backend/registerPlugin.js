import {
  PRIVACYIDEA_DEFAULT_CONFIGURATION,
  normalizePrivacyIdeaConfiguration,
  privacyIdeaProofFields,
  verifyPrivacyIdea,
} from "./privacyidea.js";

const SETTINGS_KEY = "configuration";

async function loadConfiguration(moduleSettings) {
  const stored = await moduleSettings.getLegacyJson(SETTINGS_KEY);
  return normalizePrivacyIdeaConfiguration(stored?.value || PRIVACYIDEA_DEFAULT_CONFIGURATION);
}

function adminSections() {
  return [
    {
      title: "privacyIDEA-Verbindung",
      description: "Bonni verwendet den Anmeldenamen als privacyIDEA-Benutzer. Die Prüfung erfolgt über /validate/check.",
      fields: [
        { name: "baseUrl", label: "Server-URL", type: "text", placeholder: "https://privacyidea.example.org", help: "HTTPS ist verpflichtend; HTTP ist nur auf localhost zulässig." },
        { name: "realm", label: "Realm (optional)", type: "text", placeholder: "bonni" },
        { name: "timeoutMs", label: "Server-Zeitlimit in Millisekunden", type: "number", min: 1000, max: 30000 },
      ],
    },
    {
      title: "Challenge und Fehlversuche",
      description: "Die Standardwerte sind 1 Minute Gültigkeit und 8 Versuche.",
      fields: [
        { name: "challengeExpiresSeconds", label: "Gültigkeit in Sekunden", type: "number", min: 30, max: 600, help: "60 Sekunden entsprechen einer Minute." },
        { name: "maxAttempts", label: "Erlaubte Versuche", type: "number", min: 1, max: 20 },
      ],
    },
    {
      title: "Token und Passwort",
      description: "Bonni setzt beide Eingaben erst unmittelbar vor der Prüfung zusammen und speichert das Passwort nicht.",
      fields: [
        {
          name: "credentialOrder",
          label: "Reihenfolge",
          type: "select",
          options: [
            { value: "TOKEN_PASSWORD", label: "Token + Passwort" },
            { value: "PASSWORD_TOKEN", label: "Passwort + Token" },
          ],
        },
        {
          name: "passwordSource",
          label: "Verwendetes Passwort",
          type: "select",
          options: [
            { value: "BONNI_PASSWORD", label: "Bonni-Passwort erneut eingeben" },
            { value: "SEPARATE_PASSWORD", label: "Separates privacyIDEA-Passwort" },
          ],
        },
      ],
    },
  ];
}

export async function registerModule({ services, logger }) {
  if (!services?.moduleSettings || services.moduleSettings.contractVersion !== "bonni.module-settings/v1") {
    throw new Error("PRIVACYIDEA_MODULE_SETTINGS_PORT_REQUIRED");
  }
  if (!services?.twoFactorProvider || services.twoFactorProvider.contractVersion !== "bonni.two-factor-provider/v1") {
    throw new Error("PRIVACYIDEA_TWO_FACTOR_PROVIDER_PORT_REQUIRED");
  }
  if (typeof services.moduleSettings.putJson !== "function") {
    throw new Error("PRIVACYIDEA_WRITABLE_MODULE_SETTINGS_REQUIRED");
  }

  const provider = {
    id: "privacyidea",
    label: "privacyIDEA",
    async getState() {
      const config = await loadConfiguration(services.moduleSettings);
      return {
        enabled: config.enabled,
        configured: Boolean(config.baseUrl),
        policy: {
          challengeExpiresSeconds: config.challengeExpiresSeconds,
          maxAttempts: config.maxAttempts,
          proofFields: privacyIdeaProofFields(config),
        },
        details: {
          realm: config.realm || null,
          credentialOrder: config.credentialOrder,
          passwordSource: config.passwordSource,
        },
      };
    },
    async verify(input) {
      return verifyPrivacyIdea(await loadConfiguration(services.moduleSettings), input);
    },
    async getAdminConfiguration() {
      const config = await loadConfiguration(services.moduleSettings);
      return { values: { ...config }, sections: adminSections() };
    },
    async updateAdminConfiguration(values) {
      const config = normalizePrivacyIdeaConfiguration(values);
      await services.moduleSettings.putJson(SETTINGS_KEY, config);
      logger?.info?.("privacyIDEA-Konfiguration aktualisiert", {
        enabled: config.enabled,
        realm: config.realm || null,
        challengeExpiresSeconds: config.challengeExpiresSeconds,
        maxAttempts: config.maxAttempts,
        credentialOrder: config.credentialOrder,
        passwordSource: config.passwordSource,
      });
      return { values: { ...config }, sections: adminSections() };
    },
  };

  return services.twoFactorProvider.registerProvider(provider);
}

export default registerModule;
