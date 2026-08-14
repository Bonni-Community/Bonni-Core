import assert from "node:assert/strict";
import test from "node:test";

process.env.MASTER_KEY ||= "test-master-key-at-least-16-characters";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/bonni_test";
process.env.SYSTEM_VERSION ||= "0.1.10";

const {
  compareVersions,
  evaluateModuleCompatibility,
} = await import("../dist/platform/module-manager/compatibility/module-compatibility.service.js");

test("Bonni Core versions are compared numerically", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
});

test("manifest minimum and maximum Core versions are enforced", () => {
  const manifest = {
    key: "addon.example",
    metadata: { minimumCoreVersion: "0.1.9", maximumCoreVersion: "0.1.12" },
    dependsOn: ["core.auth", "core.permissions"],
  };

  assert.equal(evaluateModuleCompatibility(manifest, { coreVersion: "0.1.10" }).ok, true);
  assert.equal(evaluateModuleCompatibility(manifest, { coreVersion: "0.1.8" }).coreVersionCompatible, false);
  assert.equal(evaluateModuleCompatibility(manifest, { coreVersion: "0.1.13" }).coreVersionCompatible, false);
});

test("module dependencies must exist and can be required to be enabled", () => {
  const manifest = { key: "addon.child", dependsOn: ["addon.parent"] };
  const installedModules = [{
    key: "addon.parent",
    name: "Parent",
    kind: "addon",
    version: "1.0.0",
    status: "disabled",
    installed: true,
    enabled: false,
  }];

  assert.equal(evaluateModuleCompatibility(manifest, {
    coreVersion: "0.1.10",
    installedModules,
  }).ok, true);

  const activation = evaluateModuleCompatibility(manifest, {
    coreVersion: "0.1.10",
    installedModules,
    requireDependenciesEnabled: true,
  });
  assert.equal(activation.ok, false);
  assert.match(activation.reasons.join(" "), /nicht aktiviert/);
});

test("a missing dependency blocks installation", () => {
  const compatibility = evaluateModuleCompatibility({
    key: "addon.child",
    dependsOn: ["addon.missing"],
  }, { coreVersion: "0.1.10", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, false);
  assert.equal(compatibility.dependencies[0].source, "missing");
});

test("targeted network requests are exposed as a Core capability", () => {
  const compatibility = evaluateModuleCompatibility({
    key: "addon.network-consumer",
    dependsOn: ["core.network-requests"],
  }, { coreVersion: "0.1.12", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, true);
  assert.deepEqual(compatibility.dependencies[0], {
    key: "core.network-requests",
    source: "core",
    installed: true,
    enabled: true,
    satisfied: true,
  });
});

test("module-bound media storage is exposed as a Core capability", () => {
  const compatibility = evaluateModuleCompatibility({
    key: "app.media-consumer",
    dependsOn: ["core.media"],
  }, { coreVersion: "0.1.15", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, true);
  assert.deepEqual(compatibility.dependencies[0], {
    key: "core.media",
    source: "core",
    installed: true,
    enabled: true,
    satisfied: true,
  });
});

test("interactive module terminals are exposed as a Core capability", () => {
  const compatibility = evaluateModuleCompatibility({
    key: "app.terminal-consumer",
    dependsOn: ["core.terminal-accounts"],
  }, { coreVersion: "0.1.15", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, true);
  assert.deepEqual(compatibility.dependencies[0], {
    key: "core.terminal-accounts",
    source: "core",
    installed: true,
    enabled: true,
    satisfied: true,
  });
});

test("centrally managed video conferencing is exposed as a Core capability", () => {
  const compatibility = evaluateModuleCompatibility({
    key: "app.video-consumer",
    dependsOn: ["core.video-conferencing"],
  }, { coreVersion: "0.1.17", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, true);
  assert.deepEqual(compatibility.dependencies[0], {
    key: "core.video-conferencing",
    source: "core",
    installed: true,
    enabled: true,
    satisfied: true,
  });
});

test("identity, members, archive and transition settings are Core capabilities", () => {
  const dependencies = [
    "core.request-identity",
    "core.members",
    "core.archive",
    "core.module-settings",
    "core.two-factor",
    "core.two-factor-provider",
    "core.private-data",
    "core.domain-messages",
    "core.protected-people",
  ];
  const compatibility = evaluateModuleCompatibility({
    key: "app.core-ports-consumer",
    dependsOn: dependencies,
  }, { coreVersion: "0.1.15", installedModules: [], manifests: [] });

  assert.equal(compatibility.ok, true);
  assert.deepEqual(
    compatibility.dependencies.map((entry) => ({
      key: entry.key,
      source: entry.source,
      satisfied: entry.satisfied,
    })),
    dependencies.map((key) => ({
      key,
      source: "core",
      satisfied: true,
    })),
  );
});
