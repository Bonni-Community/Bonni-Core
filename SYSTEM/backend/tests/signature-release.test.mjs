import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_TARGETS,
  detectCurrentVersion,
  parseSignatureReleaseArguments,
  runSignatureRelease,
  signatureReleaseHelp,
} from "../scripts/signature-release/signature-release.mjs";

async function write(root, relativePath, contents, options) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, options);
  return target;
}

async function fixture(t, { target = "core", policyOverrides = {}, version = "1.2.3" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-signature-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, "SYSTEM");
  const signatureRoot = path.join(root, "BONNI_SIGNATUR");
  const definition = RELEASE_TARGETS[target];
  const componentRoot = path.join(systemRoot, definition.componentDirectory);
  for (const versionFile of definition.versionFiles) {
    await write(componentRoot, versionFile, `${JSON.stringify({ name: "fixture", version })}\n`);
  }

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const policyRoot = path.join(signatureRoot, definition.policyDirectory);
  await write(policyRoot, "keys/release-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const policy = {
    schemaVersion: 1,
    productId: definition.productId,
    keyScope: definition.keyScope,
    keyId: `${target}-release-2026-01`,
    privateKeyRelativePath: "keys/release-private.pem",
    ...policyOverrides,
  };
  await write(policyRoot, "policy.json", `${JSON.stringify(policy, null, 2)}\n`);
  return { root, systemRoot, signatureRoot, definition, policyRoot, policy };
}

test("definiert getrennte Produkt- und Schluesselbereiche fuer Core und jede App", () => {
  const definitions = Object.values(RELEASE_TARGETS);
  assert.equal(new Set(definitions.map((entry) => entry.productId)).size, 4);
  assert.equal(new Set(definitions.map((entry) => entry.keyScope)).size, 4);
  assert.deepEqual(definitions.map((entry) => entry.keyScope), [
    "core",
    "app:kontor",
    "app:stueberl",
    "app:hocket",
  ]);
  assert.equal(RELEASE_TARGETS.core.installable, true);
  assert.equal(RELEASE_TARGETS.kontor.installable, false);
});

test("liest SIGNATUR nur explizit per Argument oder Umgebungsvariable", () => {
  assert.deepEqual(
    parseSignatureReleaseArguments(["core", "--signature-root", "X:/BONNI_SIGNATUR", "--dry-run"], {}),
    {
      target: "core",
      signatureRoot: "X:/BONNI_SIGNATUR",
      systemRoot: undefined,
      archive: undefined,
      image: undefined,
      outputDirectory: undefined,
      title: undefined,
      descriptionDe: undefined,
      descriptionEn: undefined,
      migration: undefined,
      schemaFrom: undefined,
      schemaTo: undefined,
      expiresDays: undefined,
      repository: undefined,
      artifactUrl: undefined,
      dryRun: true,
      help: false,
    },
  );
  assert.equal(
    parseSignatureReleaseArguments(["core", "--dry-run"], { BONNI_SIGNATURE_ROOT: "E:/SIGNATUR" }).signatureRoot,
    "E:/SIGNATUR",
  );
  assert.equal(parseSignatureReleaseArguments(["--help"], {}).help, true);
  assert.match(signatureReleaseHelp(), /BONNI_SIGNATURE_ROOT/u);
  assert.throws(() => parseSignatureReleaseArguments(["core", "--unknown"], {}), /RELEASE_ARGUMENT_UNKNOWN/u);
});

test("Core-Trockenlauf prueft Policy, Ed25519-Schluessel und aktuelle Version", async (t) => {
  const { systemRoot, signatureRoot } = await fixture(t, { version: "0.1.19+d" });
  const result = await runSignatureRelease({ target: "core", systemRoot, signatureRoot, dryRun: true });
  assert.deepEqual(result, {
    target: "core",
    label: "Bonni Core",
    productId: "bonni-core",
    keyScope: "core",
    keyId: "core-release-2026-01",
    version: "0.1.19+d",
    state: "dry-run",
    artifactReady: false,
    nextStep: "build-oci-artifact",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|release-private\.pem/u);
});

test("ermittelt die Core-Version geschlossen und lehnt unterschiedliche Teilversionen ab", async (t) => {
  const { systemRoot } = await fixture(t);
  assert.equal(await detectCurrentVersion(systemRoot, RELEASE_TARGETS.core), "1.2.3");
  await write(systemRoot, "frontend/package.json", '{"version":"1.2.4"}\n');
  await assert.rejects(
    detectCurrentVersion(systemRoot, RELEASE_TARGETS.core),
    /RELEASE_VERSION_MISMATCH/u,
  );
});

test("fehlender SIGNATUR-Root und fehlende Policy brechen hart ab", async (t) => {
  const { systemRoot, signatureRoot } = await fixture(t);
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot, dryRun: true }),
    /SIGNATURE_ROOT_REQUIRED/u,
  );
  await fs.unlink(path.join(signatureRoot, "core", "policy.json"));
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot, signatureRoot, dryRun: true }),
    /SIGNATURE_POLICY_MISSING/u,
  );
});

test("eine Policy fuer den falschen Produkt- oder Key-Scope wird nie verwendet", async (t) => {
  const wrongProduct = await fixture(t, { policyOverrides: { productId: "bonni-app-kontor" } });
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: wrongProduct.systemRoot, signatureRoot: wrongProduct.signatureRoot, dryRun: true }),
    /SIGNATURE_POLICY_PRODUCT_SCOPE_MISMATCH/u,
  );

  const wrongScope = await fixture(t, { policyOverrides: { keyScope: "app:kontor" } });
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: wrongScope.systemRoot, signatureRoot: wrongScope.signatureRoot, dryRun: true }),
    /SIGNATURE_POLICY_KEY_SCOPE_MISMATCH/u,
  );
});

test("private Schluessel duerfen den Scope nicht verlassen und muessen Ed25519 sein", async (t) => {
  const escaped = await fixture(t, { policyOverrides: { privateKeyRelativePath: "../fremd.pem" } });
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: escaped.systemRoot, signatureRoot: escaped.signatureRoot, dryRun: true }),
    /SIGNATURE_POLICY_PRIVATE_KEY_PATH_INVALID/u,
  );

  const rsa = await fixture(t);
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(
    path.join(rsa.policyRoot, "keys", "release-private.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: rsa.systemRoot, signatureRoot: rsa.signatureRoot, dryRun: true }),
    /SIGNATURE_PRIVATE_KEY_REQUIRES_ED25519/u,
  );
});

test("Symlinks fuer Policy oder privaten Schluessel werden abgewiesen", { skip: process.platform === "win32" }, async (t) => {
  const linkedPolicy = await fixture(t);
  const realPolicy = path.join(linkedPolicy.policyRoot, "policy-real.json");
  await fs.rename(path.join(linkedPolicy.policyRoot, "policy.json"), realPolicy);
  await fs.symlink(realPolicy, path.join(linkedPolicy.policyRoot, "policy.json"));
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: linkedPolicy.systemRoot, signatureRoot: linkedPolicy.signatureRoot, dryRun: true }),
    /SYMLINK_FORBIDDEN/u,
  );

  const linkedKey = await fixture(t);
  const keyFile = path.join(linkedKey.policyRoot, "keys", "release-private.pem");
  const realKey = path.join(linkedKey.policyRoot, "keys", "release-real.pem");
  await fs.rename(keyFile, realKey);
  await fs.symlink(realKey, keyFile);
  await assert.rejects(
    runSignatureRelease({ target: "core", systemRoot: linkedKey.systemRoot, signatureRoot: linkedKey.signatureRoot, dryRun: true }),
    /SYMLINK_FORBIDDEN/u,
  );
});

test("App-Ziele pruefen ihren eigenen Scope, erzeugen aber noch kein falsches Installationspaket", async (t) => {
  for (const target of ["kontor", "stueberl", "hocket"]) {
    const current = await fixture(t, { target, version: "2.3.4" });
    await assert.rejects(
      runSignatureRelease({ target, systemRoot: current.systemRoot, signatureRoot: current.signatureRoot, dryRun: true }),
      new RegExp(`APP_RELEASE_NOT_INSTALLABLE_YET: ${current.definition.label}`, "u"),
    );
  }
});

test("Core orchestriert den bestehenden create-release-Prozess ohne Geheimnis im Ergebnis", async (t) => {
  const current = await fixture(t, { version: "1.2.3" });
  const archive = await write(current.root, "artifacts/core.oci", "OCI fixture");
  const digest = "a".repeat(64);
  let invocation;
  const result = await runSignatureRelease({
    target: "core",
    systemRoot: current.systemRoot,
    signatureRoot: current.signatureRoot,
    archive,
    image: `registry.example/bonni/core@sha256:${digest}`,
    outputDirectory: path.join(current.root, "GITHUB", "installable", "core-1.2.3"),
    processRunner: async (command, args, processOptions) => {
      invocation = { command, args, processOptions };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /update-release[/\\]create-release\.mjs$/u);
  assert.equal(invocation.args[invocation.args.indexOf("--version") + 1], "1.2.3");
  assert.equal(invocation.args[invocation.args.indexOf("--key-id") + 1], "core-release-2026-01");
  assert.match(invocation.args[invocation.args.indexOf("--private-key") + 1], /release-private\.pem$/u);
  assert.equal(result.state, "created");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|release-private\.pem/u);
});

test("echter Lauf baut ohne OCI-Eingaben automatisch ein Docker-Artefakt", async (t) => {
  const current = await fixture(t);
  await write(current.systemRoot, "backend/Dockerfile", "FROM scratch\n");
  const calls = [];
  const imageId = `sha256:${"c".repeat(64)}`;
  const result = await runSignatureRelease({
    target: "core",
    systemRoot: current.systemRoot,
    signatureRoot: current.signatureRoot,
    processRunner: async (command, args) => {
      calls.push({ command, args });
      if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
        return { code: 0, stdout: JSON.stringify({ Id: imageId, RepoDigests: [], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (command === "docker" && args[0] === "image" && args[1] === "save") {
        await fs.writeFile(args[args.indexOf("--output") + 1], "OCI fixture");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls.slice(0, 3).map((entry) => entry.args.slice(0, 2)), [
    ["build", "--file"],
    ["image", "inspect"],
    ["image", "save"],
  ]);
  assert.equal(calls[3].command, process.execPath);
  assert.equal(result.releaseTag, "v1.2.3");
  assert.equal(result.publicKeyFingerprint.length, 64);

  await assert.rejects(
    runSignatureRelease({
      target: "core",
      systemRoot: current.systemRoot,
      signatureRoot: current.signatureRoot,
      archive: path.join(current.root, "only.oci"),
    }),
    /CORE_RELEASE_ARCHIVE_AND_IMAGE_REQUIRED/u,
  );
  await assert.rejects(
    runSignatureRelease({
      target: "core",
      systemRoot: current.systemRoot,
      signatureRoot: current.signatureRoot,
      archive: path.join(current.root, "missing.oci"),
      image: `registry.example/bonni/core@sha256:${"b".repeat(64)}`,
    }),
    /CORE_RELEASE_ARCHIVE_MISSING/u,
  );
});

test("GITHUB TRUST bleibt bei identischem Public Key auch unter Windows unveraendert", async (t) => {
  const current = await fixture(t, { version: "1.2.3" });
  const archive = await write(current.root, "artifacts/idempotent-core.oci", "OCI fixture");
  const options = {
    target: "core",
    systemRoot: current.systemRoot,
    signatureRoot: current.signatureRoot,
    archive,
    image: `registry.example/bonni/core@sha256:${"d".repeat(64)}`,
    processRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const first = await runSignatureRelease(options);
  const trustRoot = path.join(current.root, "GITHUB", "TRUST");
  const pemFile = path.join(trustRoot, `${first.keyId}.pem`);
  const metadataFile = path.join(trustRoot, `${first.keyId}.json`);
  const oldDate = new Date("2001-02-03T04:05:06.000Z");
  await fs.utimes(pemFile, oldDate, oldDate);
  await fs.utimes(metadataFile, oldDate, oldDate);
  const before = {
    pem: await fs.stat(pemFile),
    metadata: await fs.stat(metadataFile),
    pemContents: await fs.readFile(pemFile),
    metadataContents: await fs.readFile(metadataFile),
  };

  const second = await runSignatureRelease(options);
  const after = {
    pem: await fs.stat(pemFile),
    metadata: await fs.stat(metadataFile),
  };
  assert.equal(second.publicKeyFingerprint, first.publicKeyFingerprint);
  assert.equal(after.pem.mtimeMs, before.pem.mtimeMs);
  assert.equal(after.metadata.mtimeMs, before.metadata.mtimeMs);
  assert.deepEqual(await fs.readFile(pemFile), before.pemContents);
  assert.deepEqual(await fs.readFile(metadataFile), before.metadataContents);
});

test("abweichender Public Key mit gleicher keyId bricht fail-closed ab und wird nie ueberschrieben", async (t) => {
  const current = await fixture(t, { version: "1.2.3" });
  const archive = await write(current.root, "artifacts/key-conflict-core.oci", "OCI fixture");
  const options = {
    target: "core",
    systemRoot: current.systemRoot,
    signatureRoot: current.signatureRoot,
    archive,
    image: `registry.example/bonni/core@sha256:${"e".repeat(64)}`,
    processRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const first = await runSignatureRelease(options);
  const trustRoot = path.join(current.root, "GITHUB", "TRUST");
  const pemFile = path.join(trustRoot, `${first.keyId}.pem`);
  const metadataFile = path.join(trustRoot, `${first.keyId}.json`);
  const trustedPem = await fs.readFile(pemFile);
  const trustedMetadata = await fs.readFile(metadataFile);

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(
    path.join(current.policyRoot, "keys", "release-private.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await assert.rejects(
    runSignatureRelease(options),
    new RegExp(`PUBLIC_TRUST_KEY_ID_CONFLICT: ${first.keyId}`, "u"),
  );
  assert.deepEqual(await fs.readFile(pemFile), trustedPem);
  assert.deepEqual(await fs.readFile(metadataFile), trustedMetadata);
});

test("abweichende Trust-Metadaten mit gleicher keyId bleiben erhalten und blockieren die Erstellung", async (t) => {
  const current = await fixture(t, { version: "1.2.3" });
  const archive = await write(current.root, "artifacts/metadata-conflict-core.oci", "OCI fixture");
  const options = {
    target: "core",
    systemRoot: current.systemRoot,
    signatureRoot: current.signatureRoot,
    archive,
    image: `registry.example/bonni/core@sha256:${"f".repeat(64)}`,
    processRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const first = await runSignatureRelease(options);
  const trustRoot = path.join(current.root, "GITHUB", "TRUST");
  const pemFile = path.join(trustRoot, `${first.keyId}.pem`);
  const metadataFile = path.join(trustRoot, `${first.keyId}.json`);
  const trustedPem = await fs.readFile(pemFile);
  const divergentMetadata = Buffer.from('{"manuallyChanged":true}\n');
  await fs.writeFile(metadataFile, divergentMetadata);

  await assert.rejects(
    runSignatureRelease(options),
    new RegExp(`PUBLIC_TRUST_KEY_ID_CONFLICT: ${first.keyId}`, "u"),
  );
  assert.deepEqual(await fs.readFile(pemFile), trustedPem);
  assert.deepEqual(await fs.readFile(metadataFile), divergentMetadata);
});

test("GITHUB TRUST folgt keinem vorhandenen Verzeichnis-Symlink", { skip: process.platform === "win32" }, async (t) => {
  const current = await fixture(t, { version: "1.2.3" });
  const archive = await write(current.root, "artifacts/symlink-core.oci", "OCI fixture");
  const external = path.join(current.root, "external-output");
  await fs.mkdir(external);
  await fs.symlink(external, path.join(current.root, "GITHUB"));

  await assert.rejects(
    runSignatureRelease({
      target: "core",
      systemRoot: current.systemRoot,
      signatureRoot: current.signatureRoot,
      archive,
      image: `registry.example/bonni/core@sha256:${"1".repeat(64)}`,
      processRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    }),
    /PUBLIC_TRUST_DIRECTORY_UNSAFE/u,
  );
  await assert.rejects(fs.stat(path.join(external, "TRUST")), { code: "ENOENT" });
});
