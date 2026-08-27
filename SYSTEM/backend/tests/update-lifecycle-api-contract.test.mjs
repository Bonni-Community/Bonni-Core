import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { verifyLifecycleCommand } from "../src/system/update-runner/lifecycle-contract.mjs";

const secret = Buffer.from("unit-test-request-hmac-secret-32-bytes-minimum");

async function importStrippedTypeScript(file) {
  const source = await fs.readFile(file, "utf8");
  const javascript = stripTypeScriptTypes(source, { mode: "transform" });
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("backend lifecycle signer produces the exact runner-authenticated finalize command", async () => {
  const auth = await importStrippedTypeScript(new URL(
    "../src/system/update-release/lifecycle-command-auth.ts",
    import.meta.url,
  ));
  const command = {
    schemaVersion: 1,
    commandId: "finalize-api-command-0001",
    action: "finalize",
    holdId: "request-hold-api-0001",
    generation: 7,
    issuedAt: "2026-08-22T12:00:00.000Z",
    expiresAt: "2026-08-22T12:10:00.000Z",
    nonce: "A".repeat(32),
  };
  const signed = auth.signLifecycleCommand(command, secret);
  assert.deepEqual(
    verifyLifecycleCommand(signed, secret, { now: new Date("2026-08-22T12:01:00.000Z") }),
    signed,
  );
});

test("deployment finalize API is admin-scoped, same-origin checked and uses the fixed UI contract", async () => {
  const [systemRoutes, updateRoutes, controller, service] = await Promise.all([
    fs.readFile(new URL("../src/system/routes/control-api/system.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.controller.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.service.ts", import.meta.url), "utf8"),
  ]);
  const adminGate = systemRoutes.indexOf('systemRouter.use(requireAuth, requirePermission("SYSTEM_ADMIN"))');
  const updateMount = systemRoutes.indexOf('systemRouter.use("/update-center", systemUpdateCenterRouter)');
  assert.ok(adminGate >= 0 && updateMount > adminGate);
  assert.match(updateRoutes, /post\("\/deployment-lifecycle\/finalize", finalizeDeploymentLifecycleController\)/);
  assert.match(controller, /!\["holdId", "generation"\]\.includes\(key\)/);
  assert.match(controller, /DEPLOYMENT_FINALIZE_CROSS_ORIGIN_FORBIDDEN/);
  assert.match(service, /signLifecycleCommand\(/);
  assert.match(service, /deploymentLifecycle: lifecycle/);
});

test("local 14 day lifecycle exposes exact downgrade and finalize actions", async () => {
  const [routes, controller, service, localLifecycle, localLifecyclePolicy] = await Promise.all([
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.routes.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.controller.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/update-center.service.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/local-source-deployment.service.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/system/routes/control-api/update-center/local-source-lifecycle-policy.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [controller, service, localLifecycle, localLifecyclePolicy]) {
    assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: "transform" }));
  }
  assert.match(routes, /post\("\/deployment-lifecycle\/rollback", rollbackDeploymentLifecycleController\)/);
  assert.match(controller, /INVALID_DEPLOYMENT_ROLLBACK_REQUEST/);
  assert.match(controller, /assertLifecycleSameOrigin\(req\)/);
  assert.match(service, /rollbackLocalSourceDeploymentLifecycle\(input\)/);
  assert.match(service, /resolveLocalSourceDeploymentLifecycle\(\s*localDeploymentLifecycle,\s*runner,\s*\{ localLifecycleExpected \},?\s*\)/u);
  assert.match(localLifecyclePolicy, /if \(localLifecycle\) return localLifecycle/u);
  assert.match(localLifecyclePolicy, /runner\.lifecycleAuthority === "invalid"/u);
  assert.match(localLifecyclePolicy, /if \(runner\.heartbeatFresh\) return runner\.deploymentLifecycle/u);
  assert.match(localLifecycle, /const HOLD_DAYS = 14;/);
  assert.match(localLifecycle, /const HOLD_MS = HOLD_DAYS \* 24 \* 60 \* 60_000;/);
  assert.match(localLifecycle, /assertForwardActive\(lifecycle\)/);
  assert.match(localLifecycle, /createSystemBackup\(\{ reason: backupReason \}\)/);
  assert.match(localLifecycle, /validateSystemBackup\(backup\.backup\.id\)/);
  assert.match(localLifecycle, /queueLocalSourceUpdate\(\{/);
  assert.match(localLifecycle, /automatic-14-day-expiry/);
  assert.match(localLifecycle, /LOCAL_DEPLOYMENT_STATE_INVALID/);
  assert.match(localLifecycle, /localSourceVersionRequiresLifecycle/u);
  assert.match(localLifecyclePolicy, /revision && revision >= "b"/u);
  assert.match(localLifecyclePolicy, /context\.localLifecycleExpected/u);
});
