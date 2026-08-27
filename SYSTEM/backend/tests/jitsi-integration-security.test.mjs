import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const settings = readFileSync(new URL("../src/core/video-conferencing/jitsi-settings.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/system/routes/control-api/integrations/jitsi.routes.ts", import.meta.url), "utf8");
const systemRoutes = readFileSync(new URL("../src/system/routes/control-api/system.routes.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../src/platform/module-manager/loader/module-runtime.service.ts", import.meta.url), "utf8");
const secretPolicy = await tsImport("../src/core/video-conferencing/jitsi-secret-policy.ts", import.meta.url);

test("Jitsi settings are centrally protected by SYSTEM_ADMIN and recent 2FA", () => {
  assert.match(systemRoutes, /systemRouter\.use\(requireAuth, requirePermission\("SYSTEM_ADMIN"\)\)/);
  assert.match(systemRoutes, /systemRouter\.use\("\/integrations\/jitsi", systemJitsiRouter\)/);
  assert.match(routes, /consumeVerifiedChallenge\(\{/);
  assert.match(routes, /purpose:\s*"ADMIN_ELEVATION"/);
  assert.match(routes, /maxAgeMinutes:\s*5/);
  assert.match(routes, /ADMIN_2FA_CHALLENGE_REQUIRED/);
});

test("Jitsi secret is encrypted at rest and never returned as a public setting", () => {
  assert.match(settings, /encryptAes256Gcm\(/);
  assert.match(settings, /decryptAes256GcmToUtf8\(/);
  assert.match(settings, /MODULE_PRIVATE_DATA_SECRET/);
  assert.match(settings, /secretConfigured:\s*Boolean/);
  assert.doesNotMatch(settings.match(/export type JitsiPublicSettings = \{[\s\S]*?\};/)?.[0] || "", /\bsecret:\s*string/);
  assert.doesNotMatch(settings, /String\(input\.secret|input\.secret[^\n]*\.trim\(/);
  assert.match(settings, /input\.secret !== undefined/);
  assert.match(settings, /systemSetting\.deleteMany/);
});

test("Jitsi secret policy is byte-exact and counts Unicode codepoints", () => {
  const { validateExactJitsiSecret } = secretPolicy;
  const exactly512Emoji = "😀".repeat(512);
  assert.deepEqual(validateExactJitsiSecret(exactly512Emoji), {
    ok: true,
    secret: exactly512Emoji,
    characters: 512,
    utf8Bytes: 2048,
  });
  assert.equal(validateExactJitsiSecret("😀".repeat(513)).code, "JITSI_SECRET_TOO_LONG");
  assert.equal(validateExactJitsiSecret("x".repeat(31)).code, "JITSI_SECRET_TOO_SHORT");
  assert.equal(validateExactJitsiSecret(" ".repeat(32)).ok, true, "valid secrets must never be trimmed");
  assert.equal(validateExactJitsiSecret("", { allowEmpty: true }).ok, true);
  assert.equal(validateExactJitsiSecret(1234).code, "JITSI_SECRET_INVALID_TYPE");
  for (const value of ["x".repeat(31) + "\r", "x".repeat(31) + "\n", "x".repeat(31) + "\0", "x".repeat(31) + "\uD800"]) {
    assert.equal(validateExactJitsiSecret(value).ok, false);
  }
});

test("only HTTPS origins are accepted and issued room names are module-scoped", () => {
  assert.match(settings, /parsed\.protocol !== "https:"/);
  assert.match(settings, /JITSI_SERVER_ORIGIN_REQUIRED/);
  assert.match(settings, /algorithm:\s*"HS256"/);
  assert.match(settings, /roomName = `\$\{normalizedModuleKey\.replaceAll\("\.", "-"\)\}-\$\{roomId\}`/);
});

test("video-conference port is injected only for a declared Core dependency", () => {
  assert.match(loader, /declaredDependencies\.has\("core\.video-conferencing"\)/);
  assert.match(loader, /videoConferencing:\s*createModuleVideoConferenceRuntime\(module\.key\)/);
});
