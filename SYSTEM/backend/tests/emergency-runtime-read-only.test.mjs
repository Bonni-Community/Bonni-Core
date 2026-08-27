import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { emergencyReadOnlyMethodGuard } from "../scripts/runtime/emergency-read-only-guard.mjs";

function responseRecorder() {
  const state = { status: null, payload: null };
  return {
    state,
    response: {
      status(value) { state.status = value; return this; },
      json(value) { state.payload = value; return this; },
    },
  };
}

test("Emergency direct-port application rejects every mutating HTTP method", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { state, response } = responseRecorder();
    let nextCalled = false;
    emergencyReadOnlyMethodGuard({ method }, response, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(state.status, 405);
    assert.equal(state.payload.error, "EMERGENCY_BACKEND_READ_ONLY");
  }
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const { state, response } = responseRecorder();
    let nextCalled = false;
    emergencyReadOnlyMethodGuard({ method }, response, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(state.status, null);
  }
});

test("Emergency GET paths remain DB-level read-only and cannot load production routing overrides", async () => {
  const [compose, appSource] = await Promise.all([
    fs.readFile(new URL("../docker-compose.runtime.yml", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/create-system-app.ts", import.meta.url), "utf8"),
  ]);
  const start = compose.indexOf("  backend-emergency:\n");
  const end = compose.indexOf("  db-candidate:\n", start);
  assert.ok(start >= 0 && end > start);
  const emergency = compose.slice(start, end);
  assert.match(emergency, /default_transaction_read_only%3Don/g);
  assert.equal((emergency.match(/default_transaction_read_only%3Don/g) || []).length, 3);
  assert.match(emergency, /RUN_SYSTEM_ROOT: \/app\/emergency-run-system/);
  assert.match(emergency, /\/system\/emergency:\/app\/emergency-run-system\/system\/emergency:ro/);
  assert.doesNotMatch(emergency, /:\/app\/run_system(?:\n|\s)/);
  assert.match(emergency, /\/storage:\/app\/storage:ro/);
  assert.doesNotMatch(emergency, /archive\/logs:\/app\/backend\/archives\/logs/);
  assert.match(emergency, /\/app\/backend\/archives\/logs:size=32m/);
  assert.match(emergency, /read_only: true/);
  assert.match(emergency, /127\.0\.0\.1:\$\{BACKEND_EMERGENCY_DIRECT_PORT:-4199\}:4000/);
  assert.match(emergency, /127\.0\.0\.1:\$\{BACKEND_EMERGENCY_LOCAL_PORT:-4001\}:4000/);
  const redundantStart = appSource.indexOf("export async function createRedundantSystemApp");
  const guard = appSource.indexOf("app.use(emergencyReadOnlyMethodGuard)", redundantStart);
  const routes = appSource.indexOf("app.use(\"/api\", localRouter)", redundantStart);
  assert.ok(redundantStart >= 0 && guard > redundantStart && routes > guard);
});
