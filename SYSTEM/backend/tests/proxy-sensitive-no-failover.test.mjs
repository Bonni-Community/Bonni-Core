import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("auth, Core 2FA, Kontor proofs and account writers never use emergency failover", async () => {
  const source = await readFile(
    path.join(backendRoot, "ops/runtime/nginx/default.conf.template"),
    "utf8",
  );
  const start = source.indexOf("location ~* ^/api/");
  const end = source.indexOf("\n  }", start);
  assert.ok(start > 0 && end > start);
  const sensitive = source.slice(start, end);
  assert.match(sensitive, /security\/\(\?:2fa\|account-recovery/u);
  assert.match(sensitive, /account-recovery/u);
  assert.match(sensitive, /identity/u);
  assert.match(sensitive, /auth/u);
  assert.match(sensitive, /apps\/kontorapp/u);
  assert.match(sensitive, /user\|users\|members\|accounts/u);
  assert.match(sensitive, /integrations\/jitsi\|system/u);
  assert.match(sensitive, /proxy_next_upstream off;/u);
  assert.match(sensitive, /proxy_pass http:\/\/\$\{ACTIVE_BACKEND\}:\$\{ACTIVE_BACKEND_PORT\};/u);
  assert.doesNotMatch(sensitive, /backend_runtime|EMERGENCY_BACKEND/u);

  const catchAll = source.slice(source.indexOf("location / {"));
  assert.match(catchAll, /proxy_pass http:\/\/backend_runtime;/u);
  assert.match(catchAll, /proxy_next_upstream_tries 2;/u);
});
