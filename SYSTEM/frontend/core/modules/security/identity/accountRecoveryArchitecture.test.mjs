import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const identityRoot = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(identityRoot, "../../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), "utf8");
}

test("password recovery is owned by Core Login and uses only canonical v1 routes", () => {
  const login = read("system/auth/LoginView.jsx");
  const session = read("system/auth/useSession.js");
  const flow = read("core/modules/security/identity/components/PasswordRecoveryFlow.jsx");
  const api = read("core/modules/security/identity/api/accountRecoveryApi.js");

  assert.match(login, /PasswordRecoveryFlow/);
  assert.match(login, /PasswordRecoveryLauncher/);
  assert.match(flow, /Passwort vergessen\?/);
  assert.match(session, /catch \(error\)[\s\S]*setMessage/);
  assert.doesNotMatch(session, /catch \(error\)[\s\S]{0,180}setLoginName\(""\)/);
  assert.match(flow, /Die Passwort-Wiederherstellung wurde angefordert\. Bitte wenden Sie sich an den Support\./);
  assert.doesNotMatch(flow, /Admin|Notfall|Freigabezahl/i);
  assert.match(api, /\/api\/auth\/password-recovery/);
  assert.match(api, /\/api\/security\/account-recovery/);
  assert.doesNotMatch(api, /\/api\/auth\/recovery|\/api\/identity\/auth\/recovery/);
  assert.match(api, /credentials: "include"/);
  assert.match(api, /allowFailover: false/);
  assert.match(api, /sensitive: true/);
});

test("Meine Einstellungen mounts the same Core Notfall tab for every app", () => {
  const settings = read("platform/my-settings/MySettingsPage.jsx");
  const panel = read("core/modules/security/identity/components/AccountRecoveryPanel.jsx");
  const api = read("core/modules/security/identity/api/accountRecoveryApi.js");

  assert.match(settings, /AccountRecoveryPanel/);
  assert.match(settings, /<strong>Notfall<\/strong>/);
  assert.match(settings, /canManageRecoveryPolicy/);
  assert.match(panel, /Wiederherstellung fuer ein Zielkonto anstossen/);
  assert.match(panel, /Einmaligen Support-Code ausgeben/);
  assert.match(panel, /Kopieren und ausblenden/);
  assert.match(panel, /policyProposalFromDraft/);
  assert.match(panel, /provider=\{\{ id: challenge\.provider, label: challenge\.providerLabel \}\}/);
  assert.match(panel, /proofFields=\{challenge\.proofFields\}/);
  assert.match(api, /reviewerAccountIds\.length < 3/);
  assert.match(api, /threshold.*3/);

  for (const source of [settings, panel, api]) {
    assert.doesNotMatch(source, /kontorapp|KontorApp|\/kontor/i);
  }
});

test("one-shot secrets have explicit synchronous purge paths", () => {
  const flow = read("core/modules/security/identity/components/PasswordRecoveryFlow.jsx");
  const panel = read("core/modules/security/identity/components/AccountRecoveryPanel.jsx");

  assert.match(flow, /purgeDomAndRefs/);
  assert.match(flow, /node\.value = ""/);
  assert.match(flow, /window\.addEventListener\("pagehide"/);
  assert.match(flow, /activePayloadsRef/);
  assert.match(panel, /supportCodeNodeRef\.current\.textContent = ""/);
  assert.match(panel, /supportCodeRef\.current\.supportCode = undefined/);
  assert.match(panel, /purgeSupportCode\(\);[\s\S]{0,100}await pendingCopy/);
  assert.match(panel, /window\.addEventListener\("pagehide"/);
});
