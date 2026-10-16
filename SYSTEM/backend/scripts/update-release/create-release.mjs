#!/usr/bin/env node
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertReleaseArchiveTags,
  bonniReleaseImageTag,
  signReleaseManifest,
  verifyReleaseManifest,
} from "../../dist/system/update-release/index.js";
import { loadOpsMigrations } from "../database/run-ops-migrations.mjs";
import { inspectCoreDockerArchivePayload } from "../../src/system/update-runner/archive-tags.mjs";

const ALLOWED_ARGUMENTS = new Set([
  "--archive", "--image", "--version", "--private-key", "--key-id", "--output-dir",
  "--title", "--description-de", "--description-en", "--migration", "--schema-from",
  "--schema-to", "--expires-days", "--artifact-url", "--build-authorization", "--trusted-keys",
]);

function argumentsMap() {
  const result = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!ALLOWED_ARGUMENTS.has(key) || value === undefined || value.startsWith("--")) {
      throw new Error(`Ungültiges oder unvollständiges Argument: ${key || "(leer)"}`);
    }
    if (result.has(key)) throw new Error(`Argument wurde doppelt angegeben: ${key}`);
    result.set(key, value);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`Pflichtargument fehlt: ${name}`);
  return value;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalUtc(date) {
  return date.toISOString();
}

function visibleBonniVersion(value) {
  return String(value || "").replace(/^(\d+\.\d+\.\d+)\+([A-Za-z])$/u, "$1$2");
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

async function ensureOutputDirectory(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    await fs.mkdir(cursor, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const state = await fs.lstat(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("RELEASE_OUTPUT_DIRECTORY_UNSAFE");
    if (!samePath(await fs.realpath(cursor), cursor)) throw new Error("RELEASE_OUTPUT_DIRECTORY_UNSAFE");
  }
  return absolute;
}

async function assertRegularUnlinkedFile(file, errorCode) {
  const state = await fs.lstat(file);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1 || state.size <= 0) {
    throw new Error(errorCode);
  }
  return state;
}

async function assertCleanOutputDirectory(directory, artifactName) {
  const allowed = new Set([artifactName, "manifest.json"]);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`RELEASE_OUTPUT_NOT_CLEAN: ${entry.name}`);
    }
    const state = await fs.lstat(path.join(directory, entry.name));
    if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
      throw new Error(`RELEASE_OUTPUT_FILE_UNSAFE: ${entry.name}`);
    }
  }
}

async function replaceFileAtomically(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    // Windows does not consistently replace an existing file with rename().
    // Only an already preflighted regular release file may be removed here.
    if (!["EACCES", "EEXIST", "EPERM"].includes(error?.code)) throw error;
    const state = await fs.lstat(destination);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
      throw new Error(`RELEASE_OUTPUT_FILE_UNSAFE: ${path.basename(destination)}`);
    }
    await fs.unlink(destination);
    await fs.rename(source, destination);
  }
}

const args = argumentsMap();
const buildAuthorization = args.has('--build-authorization') ? JSON.parse(await fs.readFile(required(args,'--build-authorization'),'utf8')) : undefined;
let delegatedTrustedKeys;
if(buildAuthorization){
  const trust=JSON.parse(await fs.readFile(required(args,'--trusted-keys'),'utf8'));
  if(trust.schema!=='bonni.app-install-trust/v1'||!Array.isArray(trust.keys))throw Error('PUBLIC_RELEASE_TRUST_INVALID');
  delegatedTrustedKeys=Object.fromEntries(trust.keys.filter(k=>k.scopes?.includes('RELEASE')).map(k=>[k.keyId,k.publicKey]));
}
const archive = path.resolve(required(args, "--archive"));
const image = required(args, "--image");
const imageMatch = /^([a-z0-9][a-z0-9._:/-]+)@(sha256:[a-f0-9]{64})$/.exec(image);
if (!imageMatch) throw new Error("--image muss repository@sha256:<Digest> sein.");
const [, repository, digest] = imageMatch;
const version = required(args, "--version");
const imageTag = bonniReleaseImageTag(version);
const privateKeyFile = path.resolve(required(args, "--private-key"));
const keyId = args.get("--key-id") || "bonni-core-release";
const outputDirectory = path.resolve(args.get("--output-dir") || path.join("releases", version));
const packagedOpsMigrations = await loadOpsMigrations();
const migrationStrategy = args.get("--migration")
  || (packagedOpsMigrations.length > 0 ? "offline" : "none");
if (!["none", "expand-contract", "offline"].includes(migrationStrategy)) throw new Error("--migration ist ungültig.");
if (packagedOpsMigrations.length > 0 && !["expand-contract", "offline"].includes(migrationStrategy)) {
  throw new Error("RELEASE_OPS_MIGRATIONS_REQUIRE_DECLARED_MIGRATION");
}
const migrationRequired = migrationStrategy !== "none";
const schemaFrom = args.get("--schema-from") || version;
const schemaTo = args.get("--schema-to") || schemaFrom;
const expiryDays = Number(args.get("--expires-days") || 90);
if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 90) throw new Error("--expires-days muss zwischen 1 und 90 liegen.");

await assertRegularUnlinkedFile(archive, "Das OCI-Archiv fehlt, ist leer oder unsicher.");
await assertRegularUnlinkedFile(privateKeyFile, "Der private Release-Schluessel fehlt oder ist unsicher.");
await ensureOutputDirectory(outputDirectory);
const [realOutputDirectory, realPrivateKeyFile] = await Promise.all([
  fs.realpath(outputDirectory),
  fs.realpath(privateKeyFile),
]);
if (isWithin(realOutputDirectory, realPrivateKeyFile)) {
  throw new Error("RELEASE_PRIVATE_KEY_INSIDE_OUTPUT_FORBIDDEN");
}

const artifactName = `bonni-core-${imageTag}.oci`;
await assertCleanOutputDirectory(outputDirectory, artifactName);
const outputArchive = path.join(outputDirectory, artifactName);
const manifestFile = path.join(outputDirectory, "manifest.json");
const nonce = `${process.pid}.${crypto.randomBytes(12).toString("hex")}`;
const temporaryArchive = path.join(outputDirectory, `.${artifactName}.${nonce}.tmp`);
const temporaryManifest = path.join(outputDirectory, `.manifest.json.${nonce}.tmp`);

let archiveIdentity;
let outputStat;
let archiveSha256;
try {
  // Validate and sign the private staged copy. A concurrent mutation of the
  // caller-owned input can therefore never change the bytes published later.
  await fs.copyFile(archive, temporaryArchive, fsConstants.COPYFILE_EXCL);
  await fs.chmod(temporaryArchive, 0o600);
  archiveIdentity = await inspectCoreDockerArchivePayload(temporaryArchive, { version });
  assertReleaseArchiveTags(
    { repository, version, imageTag },
    archiveIdentity.tags,
    {
      forbiddenTags: [
        `${repository}:active`,
        `${repository}:rollback`,
        process.env.BONNI_ACTIVE_IMAGE_TAG,
        process.env.BONNI_ROLLBACK_IMAGE_TAG,
      ].filter(Boolean),
    },
  );
  if (archiveIdentity.digest !== digest) {
    throw new Error("Das Archiv enthält nicht die angegebene, per Digest adressierte Image-Identität.");
  }
  for (const [label, expected] of [
    ["org.bonni.product", "bonni-core"],
    ["org.opencontainers.image.version", version],
    ["org.bonni.runtime.contract", "1"],
  ]) {
    if (archiveIdentity.labels[label] !== expected) {
      throw new Error(`Das Release-Image besitzt nicht das erwartete Label ${label}=${expected}.`);
    }
  }
  outputStat = await assertRegularUnlinkedFile(temporaryArchive, "RELEASE_STAGED_ARCHIVE_INVALID");
  archiveSha256 = await sha256(temporaryArchive);
  const issuedAt = new Date();
  const expiresAt = new Date(Math.min(issuedAt.getTime() + expiryDays * 24 * 60 * 60_000, buildAuthorization ? Date.parse(buildAuthorization.buildCertificate.expiresAt) : Infinity));
  const privateKey = await fs.readFile(privateKeyFile, "utf8");

  const payload = {
    schemaVersion: 2,
    product: "bonni-core",
    channel: "stable",
    version,
    artifact: {
      type: "oci-image-archive",
      sizeBytes: outputStat.size,
      sha256: archiveSha256,
      source: args.has("--artifact-url")
        ? { kind: "https", url: required(args, "--artifact-url") }
        : { kind: "local", path: artifactName },
      imageIdentity: {
        repository,
        digest,
        platform: archiveIdentity.platform,
      },
    },
    migration: {
      required: migrationRequired,
      strategy: migrationStrategy,
      fromSchemaVersion: schemaFrom,
      toSchemaVersion: schemaTo,
      backwardCompatible: migrationStrategy !== "offline",
    },
    issuedAt: canonicalUtc(issuedAt),
    expiresAt: canonicalUtc(expiresAt),
    minimumRunnerVersion: buildAuthorization ? "0.5.0" : "0.4.0",
    ...(buildAuthorization ? {buildAuthorization} : {}),
    releaseNotes: {
      title: args.get("--title") || `Bonni Core ${visibleBonniVersion(version)}`,
      descriptions: {
        de: args.get("--description-de") || `Bonni Core ${visibleBonniVersion(version)}`,
        en: args.get("--description-en") || `Bonni Core ${visibleBonniVersion(version)}`,
      },
    },
  };

  const signed = signReleaseManifest(payload, keyId, privateKey);
  const publicKey = crypto.createPublicKey(privateKey);
  verifyReleaseManifest(signed, {
    trustedKeys: delegatedTrustedKeys || { [keyId]: publicKey },
    expectedProduct: "bonni-core",
    expectedChannel: "stable",
    runnerVersion: "0.5.0",
    nodeEnv: "production",
  });

  const manifestHandle = await fs.open(temporaryManifest, "wx", 0o600);
  try {
    await manifestHandle.writeFile(`${JSON.stringify(signed, null, 2)}\n`, "utf8");
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  await replaceFileAtomically(temporaryArchive, outputArchive);
  await replaceFileAtomically(temporaryManifest, manifestFile);
} finally {
  await fs.unlink(temporaryArchive).catch(() => undefined);
  await fs.unlink(temporaryManifest).catch(() => undefined);
}
console.log(`Release erstellt: ${manifestFile}`);
console.log(`OCI-Archiv: ${outputArchive}`);
