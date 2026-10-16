import {verifyBuildAuthorization} from "./build-authorization.mjs";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { compareStrictSemVer } from "./contract.mjs";
import { isInside, listRegularFiles, readJson, resolveExistingFileInside } from "./io.mjs";
import { parseEd25519SpkiPublicKey } from "./trusted-keys.mjs";

export const RELEASE_SIGNATURE_DOMAIN = "BONNI_CORE_RELEASE_MANIFEST_V2";

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CANONICAL_JSON_REQUIRES_SAFE_INTEGER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error(`UNSUPPORTED_CANONICAL_JSON_TYPE:${typeof value}`);
}

export function canonicalReleasePayload(release) {
  const { signature: _signature, ...unsigned } = release;
  return Buffer.from(`${RELEASE_SIGNATURE_DOMAIN}\n${canonicalJson(unsigned)}\n`, "utf8");
}

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifySignedRelease({ release, artifactPath, trustedKeys, runnerVersion, now = new Date() }) {
  if (compareStrictSemVer(runnerVersion, release.minimumRunnerVersion) < 0) throw new Error("RELEASE_RUNNER_TOO_OLD");
  const timestamp = now.getTime();
  if (timestamp + 5 * 60_000 < Date.parse(release.issuedAt)) throw new Error("RELEASE_NOT_YET_VALID");
  if (timestamp - 5 * 60_000 > Date.parse(release.expiresAt)) throw new Error("RELEASE_EXPIRED");
  if (Date.parse(release.expiresAt) - Date.parse(release.issuedAt) > 90 * 24 * 60 * 60_000) throw new Error("RELEASE_VALIDITY_WINDOW_TOO_LONG");
  if (!release.signature) throw new Error("UNSIGNED_RELEASE_FORBIDDEN_IN_PRODUCTION");
  const publicKeyInput = release.buildAuthorization
    ? verifyBuildAuthorization(release.buildAuthorization, {trustedKeys,version:release.version,product:release.product,channel:release.channel,keyId:release.signature.keyId,now,issuedAt:release.issuedAt,expiresAt:release.expiresAt})
    : trustedKeys instanceof Map ? trustedKeys.get(release.signature.keyId) : trustedKeys?.[release.signature.keyId];
  if (!publicKeyInput) throw new Error("UNTRUSTED_RELEASE_KEY");
  const publicKey = parseEd25519SpkiPublicKey(publicKeyInput);
  const valid = crypto.verify(null, canonicalReleasePayload(release), publicKey, Buffer.from(release.signature.value, "base64"));
  if (!valid) throw new Error("INVALID_RELEASE_SIGNATURE");

  const stat = await fs.stat(artifactPath);
  if (!stat.isFile() || stat.size !== release.artifact.sizeBytes) throw new Error("RELEASE_ARTIFACT_SIZE_MISMATCH");
  const digest = await sha256File(artifactPath);
  if (digest !== release.artifact.sha256) throw new Error("RELEASE_ARTIFACT_HASH_MISMATCH");
  return { ok: true, digest, sizeBytes: stat.size, keyId: release.signature.keyId };
}

function backupPathPattern(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !path.isAbsolute(value)
    && !value.replaceAll("\\", "/").split("/").includes("..");
}

export async function verifyBackup({ storageRoot, backupId }) {
  const backupsRoot = path.join(storageRoot, "system", "backups");
  const backupRoot = path.join(backupsRoot, backupId);
  const backupsReal = await fs.realpath(backupsRoot);
  const backupReal = await fs.realpath(backupRoot);
  if (!isInside(backupReal, backupsReal)) throw new Error("Backup liegt außerhalb des Backup-Speichers.");
  const manifest = await readJson(path.join(backupReal, "manifest.json"));
  if (manifest?.id !== backupId || manifest?.status !== "completed" || !Array.isArray(manifest.files)) {
    throw new Error("Backup ist nicht vollständig oder gehört nicht zum Request.");
  }
  const expected = new Set();
  for (const entry of manifest.files) {
    if (!backupPathPattern(entry?.path) || expected.has(entry.path)) throw new Error("Backup-Manifest enthält ungültige Pfade.");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      throw new Error("Backup-Manifest enthält ungültige Dateidaten.");
    }
    expected.add(entry.path.replaceAll("\\", "/"));
    const resolved = await resolveExistingFileInside(backupReal, entry.path);
    if (resolved.stat.size !== entry.sizeBytes) throw new Error(`Backup-Größe stimmt nicht: ${entry.path}`);
    if (await sha256File(resolved.path) !== entry.sha256) throw new Error(`Backup-Prüfsumme stimmt nicht: ${entry.path}`);
  }
  const manifestPath = path.resolve(backupReal, "manifest.json");
  const actual = (await listRegularFiles(backupReal)).filter((file) => path.resolve(file) !== manifestPath)
    .map((file) => path.relative(backupReal, file).replaceAll("\\", "/"));
  const unexpected = actual.find((file) => !expected.has(file));
  if (unexpected) throw new Error(`Unerwartete Datei im Backup: ${unexpected}`);
  const database = await resolveExistingFileInside(backupReal, "database/database.dump");
  return { ok: true, backupRoot: backupReal, databaseDumpPath: database.path, checkedFiles: expected.size };
}
