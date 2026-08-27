import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const securityRoot = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(securityRoot, "../../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), "utf8");
}

test("Core shell owns the single Meine Einstellungen route and action", () => {
  const shell = read("system/auth/AppShell.jsx");
  const featureHost = read("system/feature-modules/FeatureModuleHost.jsx");
  assert.match(shell, /window\.location\.pathname === "\/my-settings"/);
  assert.match(shell, /<MySettingsPage/);
  assert.match(shell, /function openMySettings\(\)/);
  assert.match(featureHost, /open-my-settings/);
});

test("admin enrollment is an account-bound user-management tab", () => {
  const memberWindow = read("platform/control-center/benutzer/window/member/MemberActionWindow.jsx");
  const adminPanel = read("core/modules/security/two-factor/components/AdminEnrollmentPanel.jsx");
  assert.match(memberWindow, /AdminEnrollmentPanel/);
  assert.match(adminPanel, /ADMIN_PASSWORD_BOOTSTRAP_FIELDS/);
  assert.match(adminPanel, /adminStatus\?\.enabled[\s\S]*ADMIN_PASSWORD_BOOTSTRAP_FIELDS/);
  assert.match(memberWindow, /key: "two-factor"/);
  assert.match(adminPanel, /Exaktes Zielkonto/);
  assert.match(adminPanel, /Einmalig sichtbar/);
  assert.match(adminPanel, /copyAndDismiss/);
  assert.match(adminPanel, /PERMISSION_DENIED/);
  assert.match(adminPanel, /keine 2FA-Auftraege fuer andere Benutzer verwalten/);
  assert.doesNotMatch(adminPanel, /qrCodeDataUrl|otpauth|recoveryCodes/);
});

test("personal enrollment exists only in Core Security and renders PNG QR only", () => {
  const settings = read("platform/my-settings/MySettingsPage.jsx");
  const store = read("platform/control-center/store/StorePage.jsx");
  assert.match(settings, /startCurrentTotpEnrollment/);
  assert.match(settings, /src=\{liveTotpSetup\.qrCodeDataUrl\}/);
  assert.doesNotMatch(settings, /otpauthUri|manualSecret|includeManualSecret/);
  assert.doesNotMatch(store, /startCurrentTotpEnrollment|confirmCurrentTotpEnrollment|qrCodeDataUrl|includeManualSecret/);
});

test("seeded system.admin and the admin role expose the recovery policy controls", () => {
  const settings = read("platform/my-settings/MySettingsPage.jsx");
  assert.match(settings, /canonicalAdminKey/);
  assert.match(settings, /SYSTEM_ADMIN/);
  assert.match(settings, /raw === "\*"/);
  assert.match(settings, /user\?\.roles/);
  assert.match(settings, /canManagePolicy=\{canManageRecoveryPolicy\(user, shell\)\}/);
});

test("all two-factor API calls are sensitive, no-store and no-failover", () => {
  const api = read("core/modules/security/two-factor/api/twoFactorApi.js");
  const access = read("system/api/accessApi.js");
  assert.match(api, /allowFailover: false/);
  assert.match(api, /cache: "no-store"/);
  assert.match(api, /sensitive: true/);
  assert.match(access, /SENSITIVE_REQUEST_OPTIONS/);
  assert.match(access, /allowFailover: false/);
  assert.match(access, /cache: "no-store"/);
  assert.match(access, /sensitive: true/);
});

test("secret-bearing forms never use DOM collection or FormData fallbacks", () => {
  const files = [
    "core/modules/security/two-factor/components/ExactSecretInput.jsx",
    "core/modules/security/two-factor/components/ProviderProofForm.jsx",
    "core/modules/security/two-factor/components/AdminEnrollmentPanel.jsx",
    "platform/my-settings/MySettingsPage.jsx",
    "system/auth/LoginView.jsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /new FormData|\.elements\b/, file);
  }
});

test("Jitsi elevation consumes the same provider-proof and secure transport contract", () => {
  const api = read("system/api/jitsiSettingsApi.js");
  const panel = read("platform/control-center/schnittstellen/tab/Jitsi.jsx");
  assert.match(api, /body: \{ purpose: "ADMIN_ELEVATION" \}/);
  assert.doesNotMatch(api, /metadataJson/);
  assert.match(api, /allowFailover: false/);
  assert.match(api, /sensitive: true/);
  assert.match(panel, /<ProviderProofForm/);
  assert.doesNotMatch(panel, /setProof|useRecoveryCode/);
});

test("security changes never probe status with the revoked session", () => {
  const settings = read("platform/my-settings/MySettingsPage.jsx");
  const session = read("system/auth/useSession.js");
  assert.match(settings, /sessionRevokedMessage/);
  assert.match(settings, /onSessionRevoked/);
  assert.match(settings, /onSessionInvalidated\?\.\(\)/);
  assert.match(session, /function endRevokedSession/);
  assert.match(session, /sessionNetworkSuspendedRef/);
  assert.match(session, /sessionRequestControllersRef/);
  assert.match(session, /function suspendRevokedSession/);
  assert.match(session, /clearClientAuthStorage\(\)/);
});
