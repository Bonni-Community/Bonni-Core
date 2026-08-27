import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  assertReleaseArtifactIdentity,
  assertReleaseArchiveTags,
  assertReleaseImageIdentity,
  assertSecureReleaseHttpsUrl,
  assertSecureReleaseRedirect,
  assertSecureReleaseSource,
  bonniReleaseImageTag,
  canonicalizeReleasePayload,
  compareBonniReleaseVersion,
  compareStrictSemVer,
  parseReleaseManifest,
  loadEd25519SpkiPublicKeyFile,
  signReleaseManifest,
  signUpdateRunnerRequest,
  verifyReleaseManifest,
} = await import("../dist/system/update-release/index.js");
const { verifyUpdateRunnerRequestAuth } = await import("../src/system/update-runner/request-auth.mjs");

const now = new Date("2026-07-22T12:00:00.000Z");
const artifactHash = "1".repeat(64);
const imageHash = "2".repeat(64);

function payload(overrides = {}) {
  return {
    schemaVersion: 2,
    product: "bonni-core",
    channel: "stable",
    version: "0.1.11",
    artifact: {
      type: "oci-image-archive",
      sizeBytes: 12_345,
      sha256: artifactHash,
      source: { kind: "local", path: "bonni-core-0.1.11.oci" },
      imageIdentity: {
        repository: "registry.bonni.example/bonni/core",
        digest: `sha256:${imageHash}`,
        platform: { os: "linux", architecture: "amd64" },
      },
    },
    migration: {
      required: true,
      strategy: "expand-contract",
      fromSchemaVersion: "0.1.10",
      toSchemaVersion: "0.1.11",
      backwardCompatible: true,
    },
    issuedAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-08-01T10:00:00.000Z",
    minimumRunnerVersion: "0.2.0",
    ...overrides,
  };
}

test("schema v2 accepts only strict, closed release manifests", () => {
  assert.equal(parseReleaseManifest(payload()).schemaVersion, 2);
  for (const version of ["v0.1.11", "0.1", "01.2.3", "0.1.11/../../x", "0.1.11-beta.01"]) {
    assert.throws(() => parseReleaseManifest(payload({ version })));
  }
  assert.throws(() => parseReleaseManifest({ ...payload(), unknown: true }));
  assert.throws(() => parseReleaseManifest(payload({ channel: "stable", version: "0.1.11-beta.1" })));
  assert.throws(() => parseReleaseManifest(payload({ artifact: { ...payload().artifact, sizeBytes: 0 } })));
  assert.throws(() => parseReleaseManifest(payload({ artifact: {
    ...payload().artifact,
    source: { kind: "local", path: "../secret" },
  } })));
});

test("strict SemVer comparison follows prerelease precedence", () => {
  assert.equal(compareStrictSemVer("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareStrictSemVer("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareStrictSemVer("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("Bonni maintenance builds have a total update order and a Docker-safe tag", () => {
  assert.equal(compareBonniReleaseVersion("0.1.19+c", "0.1.19+d"), -1);
  assert.equal(compareBonniReleaseVersion("0.1.19+d", "0.1.19+c"), 1);
  assert.equal(compareBonniReleaseVersion("0.1.19+a", "0.1.19"), 1);
  assert.equal(compareBonniReleaseVersion("0.1.19+aa", "0.1.19+z"), 1);
  assert.equal(bonniReleaseImageTag("0.1.19+d"), "0.1.19-d");
});

test("Ed25519 signature binds every security-relevant release field", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const signed = signReleaseManifest(payload(), "release-main-2026", privateKey);
  const verified = verifyReleaseManifest(signed, {
    trustedKeys: { "release-main-2026": publicKey },
    runnerVersion: "0.2.0",
    nodeEnv: "production",
    expectedChannel: "stable",
    now,
  });
  assert.equal(verified.verified, true);

  const mutations = [
    { ...signed, version: "0.1.12" },
    { ...signed, channel: "beta", version: "0.1.11-beta.1" },
    { ...signed, artifact: { ...signed.artifact, type: "bonni-release-bundle" } },
    { ...signed, artifact: { ...signed.artifact, sizeBytes: signed.artifact.sizeBytes + 1 } },
    { ...signed, artifact: { ...signed.artifact, sha256: "3".repeat(64) } },
    { ...signed, artifact: { ...signed.artifact, imageIdentity: {
      ...signed.artifact.imageIdentity,
      digest: `sha256:${"4".repeat(64)}`,
    } } },
    { ...signed, migration: { ...signed.migration, backwardCompatible: false } },
    { ...signed, issuedAt: "2026-07-22T09:00:00.000Z" },
    { ...signed, expiresAt: "2026-08-02T10:00:00.000Z" },
    { ...signed, minimumRunnerVersion: "0.3.0" },
  ];
  for (const changed of mutations) {
    assert.notEqual(canonicalizeReleasePayload(changed), canonicalizeReleasePayload(signed));
    assert.throws(() => verifyReleaseManifest(changed, {
      trustedKeys: { "release-main-2026": publicKey },
      runnerVersion: "1.0.0",
      nodeEnv: "production",
      now,
    }));
  }
});

test("backend trust loader accepts only Ed25519 SPKI public keys", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-release-key-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicFile = path.join(root, "release.pem");
  const privateFile = path.join(root, "private.pem");
  await fs.writeFile(publicFile, publicKey.export({ type: "spki", format: "pem" }));
  await fs.writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }));

  assert.match(await loadEd25519SpkiPublicKeyFile(publicFile), /BEGIN PUBLIC KEY/);
  await assert.rejects(() => loadEd25519SpkiPublicKeyFile(privateFile), /ED25519_SPKI_PUBLIC_KEY/);
});

test("unsigned releases fail closed in production and for remote sources", () => {
  assert.throws(() => verifyReleaseManifest(payload(), {
    runnerVersion: "0.2.0",
    nodeEnv: "production",
    allowUnsignedDevelopment: true,
    now,
  }), /UNSIGNED_RELEASE_FORBIDDEN_IN_PRODUCTION/);

  const local = verifyReleaseManifest(payload(), {
    runnerVersion: "0.2.0",
    nodeEnv: "development",
    allowUnsignedDevelopment: true,
    now,
  });
  assert.equal(local.unsignedDevelopment, true);

  const remote = payload({ artifact: {
    ...payload().artifact,
    source: { kind: "https", url: "https://updates.bonni.de/core.oci" },
  } });
  assert.throws(() => verifyReleaseManifest(remote, {
    runnerVersion: "0.2.0",
    nodeEnv: "development",
    allowUnsignedDevelopment: true,
    now,
  }), /UNSIGNED_REMOTE_RELEASE_FORBIDDEN/);
});

test("verification enforces runner version and release lifetime", () => {
  assert.throws(() => verifyReleaseManifest(payload(), {
    runnerVersion: "0.1.9",
    nodeEnv: "development",
    allowUnsignedDevelopment: true,
    now,
  }), /RELEASE_RUNNER_TOO_OLD/);
  assert.throws(() => verifyReleaseManifest(payload(), {
    runnerVersion: "0.2.0",
    nodeEnv: "development",
    allowUnsignedDevelopment: true,
    now: new Date("2026-09-01T00:00:00.000Z"),
  }), /RELEASE_EXPIRED/);
});

test("HTTPS source policy blocks downgrade, credentials, local networks and cross-origin redirects", () => {
  assert.throws(() => assertSecureReleaseHttpsUrl("http://updates.bonni.de/core.oci"), /REQUIRES_HTTPS/);
  assert.throws(() => assertSecureReleaseHttpsUrl("https://user:secret@updates.bonni.de/core.oci"), /CREDENTIALS/);
  assert.throws(() => assertSecureReleaseHttpsUrl("https://127.0.0.1/core.oci"), /PRIVATE_ADDRESS/);
  assert.throws(() => assertSecureReleaseHttpsUrl("https://updates.bonni.de/core.oci", {
    resolvedAddresses: ["10.0.0.5"],
  }), /PRIVATE_ADDRESS/);
  assert.throws(() => assertSecureReleaseRedirect(
    "https://updates.bonni.de/manifest.json",
    "https://evil.example.net/core.oci",
  ), /ORIGIN_NOT_ALLOWED/);
  assert.equal(assertSecureReleaseHttpsUrl("https://updates.bonni.de/core.oci", {
    resolvedAddresses: ["8.8.8.8"],
  }).protocol, "https:");
});

test("local source policy confines regular files and rejects symlinks", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-release-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestFile = path.join(root, "manifest.json");
  const artifactFile = path.join(root, "bonni-core-0.1.11.oci");
  await fs.writeFile(manifestFile, "{}");
  await fs.writeFile(artifactFile, "artifact");

  const resolved = await assertSecureReleaseSource(parseReleaseManifest(payload()), {
    manifestLocation: manifestFile,
    localAllowedRoot: root,
  });
  assert.equal(resolved.kind, "local");
  assert.equal(resolved.artifactPath, artifactFile);

  const link = path.join(root, "linked.oci");
  await fs.symlink(artifactFile, link);
  const linkedManifest = parseReleaseManifest(payload({ artifact: {
    ...payload().artifact,
    source: { kind: "local", path: "linked.oci" },
  } }));
  await assert.rejects(() => assertSecureReleaseSource(linkedManifest, {
    manifestLocation: manifestFile,
    localAllowedRoot: root,
  }), /SYMLINK_FORBIDDEN/);
});

test("download and candidate identities must match the signed envelope exactly", () => {
  const manifest = parseReleaseManifest(payload());
  assert.equal(assertReleaseArtifactIdentity(manifest, { sizeBytes: 12_345, sha256: artifactHash }), true);
  assert.throws(() => assertReleaseArtifactIdentity(manifest, { sizeBytes: 12_346, sha256: artifactHash }));
  assert.equal(assertReleaseImageIdentity(manifest, manifest.artifact.imageIdentity), true);
  assert.throws(() => assertReleaseImageIdentity(manifest, {
    ...manifest.artifact.imageIdentity,
    digest: `sha256:${"9".repeat(64)}`,
  }));
});

test("release archive tags are exactly bound to signed repository and version", () => {
  const identity = { repository: "registry.bonni.example/bonni/core", version: "0.1.11" };
  assert.equal(assertReleaseArchiveTags(identity, ["registry.bonni.example/bonni/core:0.1.11"]), true);
  assert.throws(() => assertReleaseArchiveTags(identity, []), /RELEASE_ARCHIVE_VERSION_TAG_REQUIRED/);
  assert.throws(
    () => assertReleaseArchiveTags(identity, ["registry.bonni.example/bonni/core:active"], {
      forbiddenTags: ["registry.bonni.example/bonni/core:active"],
    }),
    /RELEASE_ARCHIVE_FORBIDDEN_RUNTIME_TAG/,
  );
  assert.throws(
    () => assertReleaseArchiveTags(identity, ["registry.bonni.example/bonni/core:latest"]),
    /RELEASE_ARCHIVE_UNEXPECTED_TAG/,
  );
});

test("backend and isolated runner share the exact local request HMAC contract", () => {
  const secret = Buffer.alloc(48, 7);
  const request = {
    schemaVersion: 1,
    requestId: "update-0123456789abcdef",
    workflowId: "update-0123456789abcdef",
    action: "install",
    product: "bonni-core",
    currentVersion: "0.1.10",
    targetVersion: "0.1.11",
    artifactRelativePath: "downloads/bonni-core-0.1.11.bonni",
    backupId: "backup-20260722T120000Z-abcd1234",
    issuedAt: "2026-07-22T12:00:00.000Z",
    expiresAt: "2026-07-22T14:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef0123456789abcdef",
    release: payload({
      migration: {
        required: false,
        strategy: "none",
        fromSchemaVersion: "0.1.10",
        toSchemaVersion: "0.1.10",
        backwardCompatible: true,
      },
    }),
  };
  const signed = signUpdateRunnerRequest(request, secret);
  const verified = verifyUpdateRunnerRequestAuth(signed, secret, { now });
  assert.equal(verified.requestId, request.requestId);
  assert.throws(() => verifyUpdateRunnerRequestAuth(signed, Buffer.alloc(48, 8), { now }), /HMAC_INVALID/);
});
