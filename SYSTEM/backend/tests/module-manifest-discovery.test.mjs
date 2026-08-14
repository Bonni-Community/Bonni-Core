import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "bonni-module-manifests-"));
process.env.BONNI_PROJECT_ROOT = root;

await mkdir(path.join(root, "backend"), { recursive: true });
await mkdir(path.join(root, "addons", "legacy-example"), { recursive: true });
await mkdir(path.join(root, "addons", "example"), { recursive: true });

await writeFile(
  path.join(root, "addons", "legacy-example", "manifest.ts"),
  `const manifest = {
    key: "addon.example",
    kind: "addon",
    name: "Legacy Example",
    version: "1.0.0"
  };
  export default manifest;
  `,
);

await writeFile(
  path.join(root, "addons", "example", "manifest.ts"),
  `const manifest = {
    key: "addon.example",
    kind: "addon",
    name: "Example",
    version: "1.1.0",
    metadata: { packageDirectory: "example" }
  };
  export default manifest;
  `,
);

const { listModuleManifests } = await import(
  "../dist/platform/module-manager/manifests/manifest.service.js"
);
const { parseStaticTypeScriptManifest } = await import(
  "../dist/platform/module-manager/manifests/static-manifest-parser.js"
);

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("canonical package directory wins when a legacy copy has the same module ID", async () => {
  const manifests = await listModuleManifests();
  const example = manifests.find((manifest) => manifest.key === "addon.example");

  assert.ok(example);
  assert.equal(example.name, "Example");
  assert.equal(example.version, "1.1.0");
  assert.equal(example.sourcePath, "addons/example");
  assert.equal(
    manifests.filter((manifest) => manifest.key === "addon.example").length,
    1,
  );
});

test("static manifests may compose declared arrays without executing code", () => {
  const manifest = parseStaticTypeScriptManifest(`
    const baseDelegates = ["member", "account"];
    const moduleDelegates = ["task", ...baseDelegates].sort() as const;
    const manifest = {
      key: "app.example",
      kind: "app",
      name: "Example",
      version: "1.0.0",
      metadata: { scopedDatabase: { delegates: moduleDelegates } }
    } as const;
    export default manifest;
  `);

  assert.deepEqual(
    manifest.metadata.scopedDatabase.delegates,
    ["account", "member", "task"],
  );

  assert.throws(
    () => parseStaticTypeScriptManifest(`
      const delegates = getDelegates();
      const manifest = {
        key: "app.example",
        kind: "app",
        name: "Example",
        version: "1.0.0",
        metadata: { scopedDatabase: { delegates } }
      };
      export default manifest;
    `),
    /Nicht erlaubter Wert|muss .*manifest/,
  );
});
