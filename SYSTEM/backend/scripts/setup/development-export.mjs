#!/usr/bin/env node

// Creates a shareable, unsigned DEV source ZIP from an already prepared Labor
// tree.  The archive is deliberately not an official update: it contains a
// direct SYSTEM/ tree and a small provenance document for sharing.  It is an
// output artifact, not a source for another local Labor assembly; new builds
// must use the original selected source files.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import * as zlib from "node:zlib";
import path from "node:path";

import { resolveDevelopmentBase } from "./development-base.mjs";
import { normalizeDevelopmentMetadata } from "./development-versioning.mjs";

import { collectDevelopmentTree } from "../development/release-assembly.mjs";

export const BONNI_DEVELOPMENT_BUILD_SCHEMA = "bonni.development-build/v1";
export const BONNI_DEVELOPMENT_BUILD_VERSIONED_SCHEMA = "bonni.development-build/v2";
export const BONNI_DEVELOPMENT_BUILD_MANIFEST_NAME = "BONNI-DEVELOPMENT-BUILD.json";

const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const CANDIDATE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u;
const MAX_ENTRIES = 65_535; // Classic ZIP; ZIP64 is not emitted.
const MAX_FILE_BYTES = 0xffffffff;
const MAX_ARCHIVE_BYTES = 0xffffffff;

export class BonniDevelopmentExportError extends Error {
  constructor(code, detail = "", options = undefined) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "BonniDevelopmentExportError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "", options = undefined) {
  throw new BonniDevelopmentExportError(code, detail, options);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPlainDirectory(target, code) {
  const state = await lstatOrNull(target);
  if (!state?.isDirectory() || state.isSymbolicLink()) fail(code, target);
  return state;
}

async function assertRegularFile(target, code) {
  const state = await lstatOrNull(target);
  if (!state?.isFile() || state.isSymbolicLink() || state.nlink !== 1) fail(code, target);
  return state;
}

function normalizeVersion(value, label) {
  const result = String(value || "").trim().toLowerCase();
  if (!VERSION.test(result)) fail("BONNI_DEVELOPMENT_EXPORT_VERSION_INVALID", label);
  return result;
}

function normalizeBuildId(value, fallback) {
  const result = String(value || fallback).trim();
  if (!BUILD_ID.test(result)) fail("BONNI_DEVELOPMENT_EXPORT_BUILD_ID_INVALID");
  return result;
}

function normalizeMembers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail("BONNI_DEVELOPMENT_EXPORT_MEMBERS_INVALID");
  }
  const seen = new Set();
  const members = value.map((entry, index) => {
    if (typeof entry !== "string") fail("BONNI_DEVELOPMENT_EXPORT_MEMBER_INVALID", String(index));
    const separator = entry.lastIndexOf("@");
    if (separator < 1) fail("BONNI_DEVELOPMENT_EXPORT_MEMBER_INVALID", String(index));
    const candidateId = entry.slice(0, separator);
    const packageSha256 = entry.slice(separator + 1).toLowerCase();
    if (!CANDIDATE.test(candidateId) || !HASH.test(packageSha256)) {
      fail("BONNI_DEVELOPMENT_EXPORT_MEMBER_INVALID", candidateId);
    }
    const identity = `${candidateId}\0${packageSha256}`;
    if (seen.has(identity)) fail("BONNI_DEVELOPMENT_EXPORT_MEMBER_DUPLICATE", candidateId);
    seen.add(identity);
    return { candidateId, packageSha256 };
  });
  members.sort((left, right) => (
    bytewiseCompare(left.candidateId, right.candidateId)
    || bytewiseCompare(left.packageSha256, right.packageSha256)
  ));
  return members;
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.length > 4096
    || value.includes("\\") || value.startsWith("/") || value.includes("//")
    || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("BONNI_DEVELOPMENT_EXPORT_PATH_INVALID", label);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment) || /[ .]$/u.test(segment))) {
    fail("BONNI_DEVELOPMENT_EXPORT_PATH_UNSAFE", label);
  }
  return value;
}

// Native incremental CRC is available in Node >=22.2. The table fallback
// retains support for Node 22.0/22.1. SHA-256 remains the identity check.
// https://nodejs.org/api/zlib.html#zlibcrc32data-value
const CRC_TABLE = Uint32Array.from({length:256}, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function updateZipCrc32(bytes, previous = 0, useNative = true) {
  if (useNative && typeof zlib.crc32 === 'function') return zlib.crc32(bytes, previous);
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function zipLocalHeader(name) {
  const encoded = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + encoded.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6); // UTF-8, sizes and CRC follow in descriptor.
  header.writeUInt16LE(33, 12);
  header.writeUInt16LE(encoded.length, 26);
  encoded.copy(header, 30);
  return header;
}
function zipCentralHeader(name, size, crc, offset) {
  const encoded = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46 + encoded.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8); header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20); header.writeUInt32LE(size, 24);
  header.writeUInt16LE(encoded.length, 28); header.writeUInt32LE(offset, 42);
  encoded.copy(header, 46);
  return header;
}
const sameFile = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1
  && a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function writeStoredZip(file, entries, onProgress) {
  if (entries.length < 1 || entries.length > MAX_ENTRIES) fail('BONNI_DEVELOPMENT_EXPORT_ENTRY_COUNT_INVALID');
  const handle = await fs.open(file, 'wx', 0o600);
  const archiveHash = createHash('sha256');
  const central = [];
  let offset = 0, sourceBytes = 0, files = 0;
  const progress = () => onProgress?.({phase:'export-zip', files, total:entries.length, bytes:sourceBytes});
  const write = async bytes => {
    if (offset + bytes.length > MAX_ARCHIVE_BYTES) fail('BONNI_DEVELOPMENT_EXPORT_ARCHIVE_TOO_LARGE');
    for (let at = 0; at < bytes.length;) {
      const {bytesWritten} = await handle.write(bytes, at, bytes.length - at, null);
      if (!bytesWritten) fail('BONNI_DEVELOPMENT_EXPORT_SHORT_WRITE');
      at += bytesWritten;
    }
    archiveHash.update(bytes); offset += bytes.length;
  };
  try {
    progress();
    for (const entry of entries) {
      const name = normalizeRelativePath(entry.name, 'archive.entry');
      const entryOffset = offset;
      await write(zipLocalHeader(name));
      let size = 0, crc = 0;
      const consume = async bytes => {
        size += bytes.length; sourceBytes += bytes.length;
        if (size > MAX_FILE_BYTES) fail('BONNI_DEVELOPMENT_EXPORT_FILE_TOO_LARGE', name);
        crc = updateZipCrc32(bytes, crc);
        await write(bytes);
      };
      if (entry.bytes) await consume(entry.bytes);
      else {
        const before = await assertRegularFile(entry.source, 'BONNI_DEVELOPMENT_EXPORT_TREE_FILE_INVALID');
        if (before.size !== entry.sizeBytes) fail('BONNI_DEVELOPMENT_EXPORT_TREE_CHANGED', name);
        const input = await fs.open(entry.source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          if (!sameFile(before, await input.stat())) fail('BONNI_DEVELOPMENT_EXPORT_TREE_CHANGED', name);
          const buffer = Buffer.allocUnsafe(64 * 1024), hash = createHash('sha256');
          let nextProgress = sourceBytes + 8 * 1024 * 1024;
          for (;;) {
            const {bytesRead} = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            if (size + bytesRead > before.size) fail('BONNI_DEVELOPMENT_EXPORT_TREE_CHANGED', name);
            const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await consume(chunk);
            if (sourceBytes >= nextProgress) { progress(); nextProgress = sourceBytes + 8 * 1024 * 1024; }
          }
          if (size !== before.size || hash.digest('hex') !== entry.sha256
            || !sameFile(before, await input.stat()) || !sameFile(before, await fs.lstat(entry.source))) {
            fail('BONNI_DEVELOPMENT_EXPORT_TREE_CHANGED', name);
          }
        } finally { await input.close(); }
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      central.push(zipCentralHeader(name, size, crc, entryOffset));
      files++;
      if (files % 64 === 0 || files === entries.length) progress();
    }
    const centralOffset = offset;
    for (const header of central) await write(header);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16);
    await write(end); await handle.sync();
    return {sizeBytes:offset, packageSha256:archiveHash.digest('hex')};
  } finally { await handle.close(); }
}

function normalizeTargetVersion(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return normalizeVersion(value, "targetVersion");
}

function changedFilesFromInventories(before, after) {
  const old = new Map(before.files.map((entry) => [entry.path.toLowerCase(), entry]));
  const next = new Map(after.files.map((entry) => [entry.path.toLowerCase(), entry]));
  const changes = [];
  for (const [key, entry] of next) {
    const previous = old.get(key);
    if (!previous) changes.push({ path: entry.path, action: "add", baseSha256: null, resultSha256: entry.sha256 });
    else if (previous.sha256 !== entry.sha256) {
      changes.push({ path: entry.path, action: "replace", baseSha256: previous.sha256, resultSha256: entry.sha256 });
    }
  }
  for (const [key, entry] of old) {
    if (!next.has(key)) changes.push({ path: entry.path, action: "delete", baseSha256: entry.sha256, resultSha256: null });
  }
  return changes.sort((left, right) => bytewiseCompare(left.path, right.path));
}

export async function exportDevelopmentTestTree({
  productRoot,
  testSystem,
  baseRoot,
  baseVersion,
  outputFile,
  buildId = undefined,
  targetVersion = undefined,
  branch = undefined,
  devNumber = undefined,
  dependencies = undefined,
  conflicts = undefined,
  finalTreeSha256 = undefined,
  members,
  now = undefined,
  onProgress = undefined,
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    fail("BONNI_DEVELOPMENT_EXPORT_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const resolvedProductRoot = path.resolve(productRoot);
  await assertPlainDirectory(resolvedProductRoot, "BONNI_DEVELOPMENT_EXPORT_PRODUCT_ROOT_INVALID");
  const version = normalizeVersion(baseVersion, "baseVersion");
  const resolvedTestSystem = path.resolve(String(testSystem || ""));
  const testsRoot = path.join(resolvedProductRoot, "RUN_DEV", "TESTS");
  if (!pathIsWithin(testsRoot, resolvedTestSystem)
    || path.basename(resolvedTestSystem).toUpperCase() !== "SYSTEM") {
    fail("BONNI_DEVELOPMENT_EXPORT_TEST_TREE_UNSAFE", resolvedTestSystem);
  }
  await assertPlainDirectory(resolvedTestSystem, "BONNI_DEVELOPMENT_EXPORT_TEST_TREE_MISSING");

  const resolvedBaseRoot = path.resolve(String(baseRoot || ""));
  const basis = await resolveDevelopmentBase({productRoot: resolvedProductRoot, baseVersion: version, baseRoot: resolvedBaseRoot,
    withInventory:true, onProgress:entry => onProgress?.({...entry, phase:'export-base-' + entry.phase})});

  const updateRoot = path.join(resolvedProductRoot, "UPDATE");
  await assertPlainDirectory(updateRoot, "BONNI_DEVELOPMENT_EXPORT_UPDATE_FOLDER_MISSING");
  const resolvedOutput = path.resolve(String(outputFile || ""));
  if (path.dirname(resolvedOutput) !== path.resolve(updateRoot)
    || path.extname(resolvedOutput).toLowerCase() !== ".zip") {
    fail("BONNI_DEVELOPMENT_EXPORT_OUTPUT_MUST_BE_UPDATE_ZIP", resolvedOutput);
  }
  const outputState = await lstatOrNull(resolvedOutput);
  if (outputState) fail("BONNI_DEVELOPMENT_EXPORT_OUTPUT_EXISTS", resolvedOutput);

  const normalizedMembers = normalizeMembers(members);
  const finalInventory = await collectDevelopmentTree(resolvedTestSystem, {onProgress:entry => onProgress?.({...entry, phase:'export-final-' + entry.phase})});
  if (finalTreeSha256 !== undefined) {
    const expectedTreeSha256 = String(finalTreeSha256).trim().toLowerCase();
    if (!HASH.test(expectedTreeSha256)) fail("BONNI_DEVELOPMENT_EXPORT_FINAL_TREE_HASH_INVALID");
    if (expectedTreeSha256 !== finalInventory.treeSha256) {
      fail("BONNI_DEVELOPMENT_EXPORT_FINAL_TREE_CHANGED");
    }
  }
  const baseInventory = basis.inventory;
  const hasDevelopmentIdentity = branch !== undefined || devNumber !== undefined;
  const development = hasDevelopmentIdentity
    ? normalizeDevelopmentMetadata({
      baseVersion: version,
      branch,
      devNumber,
      displayVersion: `${version}-DEV.${devNumber}`,
      targetVersion: `${version}-DEV.${devNumber}`,
      changedFiles: changedFilesFromInventories(baseInventory, finalInventory),
      requires: dependencies || [],
      dependencies: dependencies || [],
      conflicts: conflicts || [],
    })
    : null;
  const exportedTargetVersion = development?.displayVersion || normalizeTargetVersion(targetVersion);
  const generatedBuildId = normalizeBuildId(
    buildId,
    `Bonni-${(development?.displayVersion || version).replaceAll("+", "")}-${finalInventory.treeSha256.slice(0, 16)}`,
  );
  const manifest = {
    schema: development ? BONNI_DEVELOPMENT_BUILD_VERSIONED_SCHEMA : BONNI_DEVELOPMENT_BUILD_SCHEMA,
    buildId: generatedBuildId,
    channel: "development",
    artifact: "labor-dev-zip",
    createdAt: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    baseVersion: version,
    baseTreeSha256: baseInventory.treeSha256,
    targetVersion: exportedTargetVersion,
    finalTreeSha256: finalInventory.treeSha256,
    members: normalizedMembers,
    releaseReady: false,
    officialManifestRequired: true,
    promotion: "certified-github-release-required",
    ...(development ? {
      branch: development.branch,
      devNumber: development.devNumber,
      displayVersion: development.displayVersion,
      changedFiles: development.changedFiles,
      dependencies: development.dependencies,
      conflicts: development.conflicts,
    } : {}),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const treeFiles = finalInventory.files.map(entry => ({name:'SYSTEM/' + entry.path,
    source:path.join(resolvedTestSystem, ...entry.path.split('/')), sizeBytes:entry.sizeBytes, sha256:entry.sha256}));
  const entries = [
    ...treeFiles,
    { name: BONNI_DEVELOPMENT_BUILD_MANIFEST_NAME, bytes: manifestBytes },
  ].sort((left, right) => bytewiseCompare(left.name, right.name));
  let archive;
  const temporary = path.join(updateRoot, `.${path.basename(resolvedOutput)}.${randomUUID()}.partial`);
  try {
    archive = await writeStoredZip(temporary, entries, onProgress);
    // Atomic no-overwrite publication, followed by removing our private name.
    await fs.link(temporary, resolvedOutput);
    await fs.unlink(temporary);
    onProgress?.({phase:'export-ready', files:entries.length, total:entries.length, bytes:archive.sizeBytes});
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({
    schema: development ? BONNI_DEVELOPMENT_BUILD_VERSIONED_SCHEMA : BONNI_DEVELOPMENT_BUILD_SCHEMA,
    status: "exported",
    kind: "development-source",
    testable: false,
    releaseReady: false,
    outputFile: resolvedOutput,
    fileName: path.basename(resolvedOutput),
    packageSha256: archive.packageSha256,
    sizeBytes: archive.sizeBytes,
    manifestFile: BONNI_DEVELOPMENT_BUILD_MANIFEST_NAME,
    buildId: generatedBuildId,
    baseVersion: version,
    baseTreeSha256: baseInventory.treeSha256,
    targetVersion: manifest.targetVersion,
    finalTreeSha256: finalInventory.treeSha256,
    members: normalizedMembers,
    ...(development ? {
      branch: development.branch,
      devNumber: development.devNumber,
      displayVersion: development.displayVersion,
      changedFiles: development.changedFiles,
      dependencies: development.dependencies,
      conflicts: development.conflicts,
      development,
    } : {}),
  });
}
