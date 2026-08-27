import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await fs.readFile(new URL(
  "../src/system/routes/control-api/update-center/local-source-lifecycle-policy.ts",
  import.meta.url,
), "utf8");
const javascript = stripTypeScriptTypes(source, { mode: "transform" });
const {
  localSourceVersionRequiresLifecycle,
  resolveLocalSourceDeploymentLifecycle,
} = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

const unavailableDocker = {
  blocksUpdates: true,
  blockReason: "Docker-Lifecycle nicht eingerichtet",
};

test("+a bleibt einmaliger Legacy-Bootstrap, ab +b ist der lokale Beleg Pflicht", () => {
  assert.equal(localSourceVersionRequiresLifecycle("0.1.19+a"), false);
  assert.equal(localSourceVersionRequiresLifecycle("0.1.19+b"), true);
  assert.equal(localSourceVersionRequiresLifecycle("0.1.19+c"), true);
  assert.equal(localSourceVersionRequiresLifecycle("0.1.20"), false);
});

test("abwesender und unzuständiger Docker-Lifecycle sperrt lokale Pakete nicht", () => {
  assert.equal(resolveLocalSourceDeploymentLifecycle(null, {
    heartbeatFresh: false,
    lifecycleAuthority: "absent",
    deploymentLifecycle: unavailableDocker,
  }), null);
});

test("ab +b erwarteter, aber fehlender lokaler Beleg bleibt fail-closed", () => {
  const result = resolveLocalSourceDeploymentLifecycle(null, {
    heartbeatFresh: false,
    lifecycleAuthority: "absent",
    deploymentLifecycle: unavailableDocker,
  }, { localLifecycleExpected: true });
  assert.equal(result.blocksUpdates, true);
  assert.equal(result.mode, "local-source");
  assert.match(result.blockReason, /lokale Deployment-Lifecycle fehlt/u);
});

test("gültiger lokaler Abschlussbeleg behält die Engine-Zuständigkeit", () => {
  for (const state of ["finalized", "rolled-back"]) {
    const local = { blocksUpdates: false, state, holdId: `local-${state}-receipt` };
    const docker = { blocksUpdates: true, state: "holding", holdId: "unrelated-docker-hold" };
    assert.equal(resolveLocalSourceDeploymentLifecycle(local, {
      heartbeatFresh: true,
      lifecycleAuthority: "verified",
      deploymentLifecycle: docker,
    }), local);
  }
});

test("gültiger lokaler aktiver Hold bleibt strikt gesperrt", () => {
  const local = { blocksUpdates: true, state: "holding", holdId: "active-local-hold" };
  assert.equal(resolveLocalSourceDeploymentLifecycle(local, {
    heartbeatFresh: false,
    lifecycleAuthority: "absent",
    deploymentLifecycle: unavailableDocker,
  }), local);
});

test("ohne lokalen Eigentümer bleiben echte und unsichere Docker-Zustände fail-closed", () => {
  const activeDocker = { blocksUpdates: true, state: "holding", holdId: "active-docker-hold" };
  assert.equal(resolveLocalSourceDeploymentLifecycle(null, {
    heartbeatFresh: false,
    lifecycleAuthority: "verified",
    deploymentLifecycle: activeDocker,
  }), activeDocker);
  assert.equal(resolveLocalSourceDeploymentLifecycle(null, {
    heartbeatFresh: false,
    lifecycleAuthority: "invalid",
    deploymentLifecycle: unavailableDocker,
  }), unavailableDocker);
  assert.equal(resolveLocalSourceDeploymentLifecycle(null, {
    heartbeatFresh: true,
    lifecycleAuthority: "absent",
    deploymentLifecycle: unavailableDocker,
  }), unavailableDocker);
});
