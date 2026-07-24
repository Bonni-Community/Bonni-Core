#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertReleaseArchiveTags,
  signReleaseManifest,
  verifyReleaseManifest,
} from "../../dist/system/update-release/index.js";
import { inspectDockerArchiveTags } from "../../src/system/update-runner/archive-tags.mjs";

const ALLOWED_ARGUMENTS = new Set([
  "--archive", "--image", "--version", "--private-key", "--key-id", "--output-dir",
  "--title", "--description-de", "--description-en", "--migration", "--schema-from",
  "--schema-to", "--expires-days",
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

function run(command, args, timeoutMs = 30 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-1024 * 1024);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} endete mit Status ${code}.`));
    });
  });
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalUtc(date) {
  return date.toISOString();
}

const args = argumentsMap();
const archive = path.resolve(required(args, "--archive"));
const image = required(args, "--image");
const imageMatch = /^([a-z0-9][a-z0-9._:/-]+)@(sha256:[a-f0-9]{64})$/.exec(image);
if (!imageMatch) throw new Error("--image muss repository@sha256:<Digest> sein.");
const [, repository, digest] = imageMatch;
const version = required(args, "--version");
const privateKeyFile = path.resolve(required(args, "--private-key"));
const keyId = args.get("--key-id") || "bonni-core-release";
const outputDirectory = path.resolve(args.get("--output-dir") || path.join("releases", version));
const migrationStrategy = args.get("--migration") || "none";
if (!["none", "expand-contract", "offline"].includes(migrationStrategy)) throw new Error("--migration ist ungültig.");
const migrationRequired = migrationStrategy !== "none";
const schemaFrom = args.get("--schema-from") || version;
const schemaTo = args.get("--schema-to") || schemaFrom;
const expiryDays = Number(args.get("--expires-days") || 30);
if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 90) throw new Error("--expires-days muss zwischen 1 und 90 liegen.");

const archiveStat = await fs.stat(archive);
if (!archiveStat.isFile() || archiveStat.size <= 0) throw new Error("Das OCI-Archiv fehlt oder ist leer.");

const archiveTags = await inspectDockerArchiveTags(archive, { tarBinary: "/bin/tar" });
assertReleaseArchiveTags(
  { repository, version },
  archiveTags,
  {
    forbiddenTags: [
      `${repository}:active`,
      `${repository}:rollback`,
      process.env.BONNI_ACTIVE_IMAGE_TAG,
      process.env.BONNI_ROLLBACK_IMAGE_TAG,
    ].filter(Boolean),
  },
);

await run("docker", ["image", "load", "--input", archive]);
const versionTag = `${repository}:${version}`;
const inspection = await run("docker", ["image", "inspect", "--format", "{{json .}}", versionTag], 60_000);
const imageData = JSON.parse(inspection.stdout);
if (!Array.isArray(imageData.RepoDigests)
  || (imageData.RepoDigests.length > 0 && !imageData.RepoDigests.includes(image))) {
  throw new Error("Das Archiv enthält nicht die angegebene, per Digest adressierte Image-Identität.");
}
if (imageData.Os !== "linux" || !["amd64", "arm64"].includes(imageData.Architecture)) {
  throw new Error("Das Release-Image muss Linux für amd64 oder arm64 enthalten.");
}

await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const artifactName = `bonni-core-${version}.oci`;
const outputArchive = path.join(outputDirectory, artifactName);
if (path.resolve(archive) !== path.resolve(outputArchive)) await fs.copyFile(archive, outputArchive);
const outputStat = await fs.stat(outputArchive);
const issuedAt = new Date();
const expiresAt = new Date(issuedAt.getTime() + expiryDays * 24 * 60 * 60_000);
const privateKey = await fs.readFile(privateKeyFile, "utf8");

const payload = {
  schemaVersion: 2,
  product: "bonni-core",
  channel: "stable",
  version,
  artifact: {
    type: "oci-image-archive",
    sizeBytes: outputStat.size,
    sha256: await sha256(outputArchive),
    source: { kind: "local", path: artifactName },
    imageIdentity: {
      repository,
      digest,
      platform: {
        os: "linux",
        architecture: imageData.Architecture,
        ...(imageData.Variant ? { variant: imageData.Variant } : {}),
      },
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
  minimumRunnerVersion: "0.2.1",
  releaseNotes: {
    title: args.get("--title") || `Bonni Core ${version}`,
    descriptions: {
      de: args.get("--description-de") || `Bonni Core ${version}`,
      en: args.get("--description-en") || `Bonni Core ${version}`,
    },
  },
};

const signed = signReleaseManifest(payload, keyId, privateKey);
const publicKey = crypto.createPublicKey(privateKey);
verifyReleaseManifest(signed, {
  trustedKeys: { [keyId]: publicKey },
  expectedProduct: "bonni-core",
  expectedChannel: "stable",
  runnerVersion: "0.2.1",
  nodeEnv: "production",
});

const manifestFile = path.join(outputDirectory, "manifest.json");
const temporary = `${manifestFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await fs.rename(temporary, manifestFile);
console.log(`Release erstellt: ${manifestFile}`);
console.log(`OCI-Archiv: ${outputArchive}`);
