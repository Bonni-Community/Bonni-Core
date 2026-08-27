import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adapterUrl = new URL("../../plugins/2FA/backend/privacyidea.js", import.meta.url);
const adapter = existsSync(fileURLToPath(adapterUrl))
  ? await import(adapterUrl.href)
  : null;
const optionalAdapterTest = adapter ? test : test.skip;
const {
  composePrivacyIdeaPass,
  normalizePrivacyIdeaConfiguration,
  privacyIdeaProofFields,
  verifyPrivacyIdea,
} = adapter || {};

optionalAdapterTest("privacyIDEA plugin defaults to one minute and eight attempts", () => {
  const configuration = normalizePrivacyIdeaConfiguration({});
  assert.equal(configuration.challengeExpiresSeconds, 60);
  assert.equal(configuration.maxAttempts, 8);
  assert.equal(configuration.credentialOrder, "TOKEN_PASSWORD");
  assert.equal(configuration.passwordSource, "BONNI_PASSWORD");
  assert.equal(configuration.enabled, false);
});

optionalAdapterTest("privacyIDEA plugin composes token and password in the configured order", () => {
  assert.equal(composePrivacyIdeaPass({
    enabled: true,
    baseUrl: "https://privacyidea.example.org",
    credentialOrder: "TOKEN_PASSWORD",
  }, { token: "123456", password: "secret" }), "123456secret");
  assert.equal(composePrivacyIdeaPass({
    enabled: true,
    baseUrl: "https://privacyidea.example.org",
    credentialOrder: "PASSWORD_TOKEN",
  }, { token: "123456", password: "secret" }), "secret123456");
});

optionalAdapterTest("privacyIDEA plugin labels a separate password without storing it", () => {
  const fields = privacyIdeaProofFields({
    enabled: true,
    baseUrl: "https://privacyidea.example.org",
    passwordSource: "SEPARATE_PASSWORD",
  });
  assert.equal(fields[1].name, "password");
  assert.match(fields[1].label, /Separates privacyIDEA-Passwort/);
});

optionalAdapterTest("privacyIDEA plugin posts the composed pass to validate/check", async () => {
  let captured;
  const result = await verifyPrivacyIdea({
    enabled: true,
    baseUrl: "https://privacyidea.example.org/",
    realm: "bonni",
    credentialOrder: "PASSWORD_TOKEN",
  }, {
    loginName: "anna",
    proof: { token: "123456", password: "secret" },
  }, async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      async json() { return { result: { status: true, value: true } }; },
    };
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://privacyidea.example.org/validate/check");
  assert.equal(captured.options.body.get("user"), "anna");
  assert.equal(captured.options.body.get("realm"), "bonni");
  assert.equal(captured.options.body.get("pass"), "secret123456");
});

optionalAdapterTest("privacyIDEA plugin rejects active configuration without an endpoint", () => {
  assert.throws(
    () => normalizePrivacyIdeaConfiguration({ enabled: true }),
    (error) => error?.code === "PRIVACYIDEA_BASE_URL_REQUIRED",
  );
});
