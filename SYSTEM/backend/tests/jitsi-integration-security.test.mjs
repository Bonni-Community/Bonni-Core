import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../src/core/video-conferencing/jitsi-settings.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/system/routes/control-api/integrations/jitsi.routes.ts", import.meta.url), "utf8");
const systemRoutes = readFileSync(new URL("../src/system/routes/control-api/system.routes.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../src/platform/module-manager/loader/module-runtime.service.ts", import.meta.url), "utf8");

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
