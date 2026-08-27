import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installModuleLegalPayload,
  verifyStoredModuleLegalPayload,
} from "../dist/platform/module-manager/licensing/module-legal-payload.service.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-legal-"));
  const packageRoot = path.join(root, "app", "demo");
  await fs.mkdir(path.join(packageRoot, "backend", "dist", "licenses", "pkg-1.0.0"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "frontend", "dist", "licenses"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "backend", "src"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "frontend", "src"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), "notices\n");
  await fs.writeFile(path.join(packageRoot, "backend", "dist", "licenses", "THIRD_PARTY_BUNDLES.json"), "{}\n");
  await fs.writeFile(path.join(packageRoot, "backend", "dist", "licenses", "pkg-1.0.0", "LICENSE"), "MIT\n");
  await fs.writeFile(path.join(packageRoot, "frontend", "dist", "licenses", "THIRD_PARTY_BUNDLES.json"), "{}\n");
  const manifest = {
    key: "app.demo",
    kind: "app",
    name: "Demo",
    version: "1.2.3",
    sourcePath: "app/demo",
    manifestPath: "app/demo/manifest.ts",
    legal: {
      schemaVersion: "bonni.module-legal/v1",
      notices: "THIRD_PARTY_NOTICES.md",
      payloadRoots: ["backend/dist/licenses", "frontend/dist/licenses"],
      treeSha256: "",
      fileCount: 4,
    },
  };
  const files = [
    ["THIRD_PARTY_NOTICES.md", "notices\n"],
    ["backend/dist/licenses/THIRD_PARTY_BUNDLES.json", "{}\n"],
    ["backend/dist/licenses/pkg-1.0.0/LICENSE", "MIT\n"],
    ["frontend/dist/licenses/THIRD_PARTY_BUNDLES.json", "{}\n"],
  ].map(([filePath, content]) => ({
    path: filePath,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  })).sort((left, right) => left.path.localeCompare(right.path, "en"));
  manifest.legal.treeSha256 = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return { root, projectRoot: root, packageRoot, manifest, storageRoot: path.join(root, "licenses", "modules") };
}

test("legal payload is atomically centralized with an exact-tree receipt and immutable version identity", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  const first = await installModuleLegalPayload(sample.manifest, sample);
  assert.equal(first.created, true);
  assert.equal(first.targetRoot, path.join(sample.storageRoot, "app.demo", "1.2.3"));
  assert.deepEqual(first.receipt.files.map((file) => file.path), [
    "backend/dist/licenses/pkg-1.0.0/LICENSE",
    "backend/dist/licenses/THIRD_PARTY_BUNDLES.json",
    "frontend/dist/licenses/THIRD_PARTY_BUNDLES.json",
    "THIRD_PARTY_NOTICES.md",
  ].sort((left, right) => left.localeCompare(right, "en")));
  assert.match(first.receipt.treeSha256, /^[a-f0-9]{64}$/u);
  assert.equal((await verifyStoredModuleLegalPayload(first.targetRoot)).treeSha256, first.receipt.treeSha256);

  const second = await installModuleLegalPayload(sample.manifest, sample);
  assert.equal(second.created, false);

  const mismatched = structuredClone(sample.manifest);
  mismatched.legal.treeSha256 = "f".repeat(64);
  await assert.rejects(
    installModuleLegalPayload(mismatched, sample),
    /MODULE_LEGAL_MANIFEST_BINDING_MISMATCH/u,
  );
});

test("runtime-only package payload is removed only after central exact verification and repair needs no local copy", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  await fs.rm(path.join(sample.packageRoot, "backend", "src"), { recursive: true, force: true });
  await fs.rm(path.join(sample.packageRoot, "frontend", "src"), { recursive: true, force: true });
  const installed = await installModuleLegalPayload(sample.manifest, sample);
  assert.equal(installed.cleanedSource, true);
  assert.equal(await fs.lstat(path.join(sample.packageRoot, "THIRD_PARTY_NOTICES.md")).catch(() => null), null);
  assert.equal(await fs.lstat(path.join(sample.packageRoot, "backend", "dist", "licenses")).catch(() => null), null);
  const repaired = await installModuleLegalPayload(sample.manifest, sample);
  assert.equal(repaired.created, false);
  assert.equal(repaired.receipt.treeSha256, sample.manifest.legal.treeSha256);
});

test("source package repair rejects legal source drift against an existing immutable version", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  await installModuleLegalPayload(sample.manifest, sample);
  await fs.writeFile(
    path.join(sample.packageRoot, "backend", "dist", "licenses", "pkg-1.0.0", "LICENSE"),
    "MIT changed after receipt\n",
  );
  await assert.rejects(
    installModuleLegalPayload(sample.manifest, sample),
    /MODULE_LEGAL_SOURCE_DRIFT/u,
  );
});

test("legal payload rejects traversal and symlinks before creating a version directory", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  const traversal = structuredClone(sample.manifest);
  traversal.legal.notices = "../secret";
  await assert.rejects(installModuleLegalPayload(traversal, sample), /MODULE_LEGAL_PATH_INVALID/u);

  await fs.symlink(
    path.join(sample.packageRoot, "backend", "dist", "licenses"),
    path.join(sample.packageRoot, "linked-licenses"),
    "dir",
  );
  const linked = structuredClone(sample.manifest);
  linked.legal.payloadRoots = ["linked-licenses"];
  await assert.rejects(installModuleLegalPayload(linked, sample), /MODULE_LEGAL_SYMLINK_DENIED/u);
});

test("legal payload verification detects extra files and receipt replacement", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  const installed = await installModuleLegalPayload(sample.manifest, sample);
  await fs.writeFile(path.join(installed.targetRoot, "unexpected.txt"), "extra");
  await assert.rejects(verifyStoredModuleLegalPayload(installed.targetRoot), /MODULE_LEGAL_EXACT_TREE_MISMATCH/u);
});

test("legal receipt identity and every entry are strictly schema-bound", async (t) => {
  const sample = await fixture();
  t.after(() => fs.rm(sample.root, { recursive: true, force: true }));
  const installed = await installModuleLegalPayload(sample.manifest, sample);
  const receiptFile = path.join(installed.targetRoot, "RECEIPT.json");
  const original = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  // Produktiv ist der unveraenderliche Beleg absichtlich nur-lesbar. Die
  // Negativtests oeffnen ausschliesslich ihre isolierte Fixture zum Manipulieren.
  await fs.chmod(receiptFile, 0o600);
  const cases = [
    ["schema", (receipt) => { receipt.schemaVersion = "bonni.module-legal-receipt/v0"; }, /MODULE_LEGAL_RECEIPT_SCHEMA_INVALID/u],
    ["module key", (receipt) => { receipt.moduleKey = "app.other"; }, /MODULE_LEGAL_RECEIPT_IDENTITY_MISMATCH/u],
    ["module version", (receipt) => { receipt.moduleVersion = "9.9.9"; }, /MODULE_LEGAL_RECEIPT_IDENTITY_MISMATCH/u],
    ["top-level extra field", (receipt) => { receipt.unsigned = true; }, /MODULE_LEGAL_RECEIPT_SHAPE_INVALID/u],
    ["entry extra field", (receipt) => { receipt.files[0].unsigned = true; }, /MODULE_LEGAL_RECEIPT_ENTRY_SHAPE_INVALID/u],
    ["duplicate entry", (receipt) => { receipt.files.splice(1, 0, structuredClone(receipt.files[0])); }, /MODULE_LEGAL_RECEIPT_ENTRY_DUPLICATE/u],
    ["negative bytes", (receipt) => { receipt.files[0].bytes = -1; }, /MODULE_LEGAL_RECEIPT_ENTRY_BYTES_INVALID/u],
    ["invalid hash", (receipt) => { receipt.files[0].sha256 = "A".repeat(64); }, /MODULE_LEGAL_RECEIPT_ENTRY_HASH_INVALID/u],
  ];
  for (const [label, mutate, error] of cases) {
    const receipt = structuredClone(original);
    mutate(receipt);
    await fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(verifyStoredModuleLegalPayload(installed.targetRoot), error, label);
  }
  await fs.writeFile(receiptFile, `${JSON.stringify(original, null, 2)}\n`);
  await fs.chmod(receiptFile, 0o444);
  assert.equal((await verifyStoredModuleLegalPayload(installed.targetRoot)).moduleKey, sample.manifest.key);
});

test("package roots and central storage parents may not be symlinked", async (t) => {
  const packageSample = await fixture();
  t.after(() => fs.rm(packageSample.root, { recursive: true, force: true }));
  const realPackage = path.join(packageSample.root, "real-package");
  await fs.rename(packageSample.packageRoot, realPackage);
  await fs.symlink(realPackage, packageSample.packageRoot, "dir");
  await assert.rejects(
    installModuleLegalPayload(packageSample.manifest, packageSample),
    /MODULE_LEGAL_SYMLINK_DENIED/u,
  );

  const storageSample = await fixture();
  t.after(() => fs.rm(storageSample.root, { recursive: true, force: true }));
  const realStorage = path.join(storageSample.root, "real-storage");
  await fs.mkdir(realStorage, { recursive: true });
  await fs.mkdir(path.dirname(storageSample.storageRoot), { recursive: true });
  await fs.symlink(realStorage, storageSample.storageRoot, "dir");
  await assert.rejects(
    installModuleLegalPayload(storageSample.manifest, storageSample),
    /MODULE_LEGAL_SYMLINK_DENIED/u,
  );
});
