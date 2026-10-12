const manifest = {
  key: "plugin.privacyidea",
  kind: "plugin",
  name: "privacyIDEA-Provider",
  version: "0.2.2",
  description: "Bindet privacyIDEA als auswählbaren externen 2FA-Provider an die verpflichtende Bonni-Core-Security an.",
  backend: {
    entry: "backend/registerPlugin.js",
  },
  provides: [
    "plugin.privacyidea",
    "two-factor.provider.privacyidea",
  ],
  dependsOn: [
    "core.auth",
    "core.module-settings",
    "core.two-factor-provider",
  ],
  permissions: {
    provides: [],
    requires: [],
  },
  compatibility: {
    minimumCoreVersion: "0.1.17",
  },
  security: {
    requiresAuth: true,
    exposesApi: false,
    exposesFrontend: false,
    requiresAudit: true,
  },
  installation: {
    installable: true,
    autoInstall: false,
    snapshotRequired: true,
    rollbackSupported: true,
    healthcheckRequired: false,
  },
  metadata: {
    runtime: "bonni-core-extension",
    packageDirectory: "2FA",
    dataOwner: "plugin.privacyidea",
    database: {
      // Provider-Adapter ohne eigenes Datenmodell. Einstellungen laufen
      // ausschließlich über den Core-Port core.module-settings.
      mode: "none",
    },
    packageLifecycle: {
      schemaVersion: "bonni.plugin-package/v1",
      buildOwner: "module",
      coreBuildRequired: false,
    },
    runtimeContract: {
      schemaVersion: "bonni.feature-module-runtime/v2",
      ports: {
        moduleSettings: "bonni.module-settings/v1",
        twoFactorProvider: "bonni.two-factor-provider/v1",
      },
    },
    store: {
      extensionType: "plugin",
      shortDescription: "privacyIDEA als austauschbarer 2FA-Provider für Bonni Core.",
      defaultLanguage: "de",
      fallbackLanguage: "de",
      support: {
        scope: "extension",
        extensionKey: "plugin.privacyidea",
        independentlySupported: true,
        url: "https://github.com/Bonni-Community/Bonni-Core/issues/new",
      },
    },
    dataClassification: "confidential",
  },
};

export default manifest;
