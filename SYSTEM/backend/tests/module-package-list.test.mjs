import assert from "node:assert/strict";
import test from "node:test";

const { mergeModulePackages } = await import(
  "../dist/platform/module-manager/install/module-install.service.js"
);

const kontorManifest = {
  key: "app.kontorapp",
  kind: "app",
  name: "KontorApp",
  version: "0.13.0",
  dependsOn: ["core.auth"],
};

test("Store hides VereinsApp after it has been replaced by KontorApp", () => {
  const result = mergeModulePackages(
    [
      kontorManifest,
      { key: "app.vereinsapp", kind: "app", name: "VereinsApp", version: "0.2.0" },
    ],
    [
      { key: "app.kontorapp", installed: true, enabled: true, status: "enabled" },
      { key: "app.vereinsapp", installed: true, enabled: false, status: "installed" },
    ],
  );

  assert.deepEqual(result.map((module) => module.key), ["app.kontorapp"]);
  assert.equal(result[0].installed, true);
  assert.equal(result[0].enabled, true);
});

test("Store omits retired database-only package tombstones", () => {
  const result = mergeModulePackages(
    [kontorManifest],
    [{ key: "app.retired", installed: false, enabled: false, status: "deleted" }],
  );
  assert.deepEqual(result.map((module) => module.key), ["app.kontorapp"]);
  assert.equal(result[0].installed, false);
  assert.equal(result[0].status, "discovered");
});

test("Store still reports a genuinely installed package whose manifest is missing", () => {
  const result = mergeModulePackages(
    [kontorManifest],
    [{ key: "app.broken", installed: true, enabled: false, status: "installed", name: "Broken", version: "1.0.0" }],
  );
  assert.deepEqual(result.map((module) => module.key), ["app.kontorapp", "app.broken"]);
  assert.equal(result[1].compatible, false);
  assert.match(result[1].compatibility.reasons.join(" "), /kein auffindbares Manifest/);
});

test("Store API preserves declared iframe form capability", () => {
  const result = mergeModulePackages(
    [{
      ...kontorManifest,
      frontend: {
        integration: "iframe",
        sandboxCapabilities: ["downloads", "forms"],
      },
    }],
    [],
  );

  assert.deepEqual(
    result[0].frontend.sandboxCapabilities,
    ["downloads", "forms"],
  );
});
