#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  readApprovedDevelopmentChain,
  readVerifiedDevelopmentReceipt,
} from "../setup/development-package-store.mjs";
import {
  DevelopmentReleaseAssemblyError,
  assembleApprovedDevelopmentRelease,
  collectDevelopmentTree,
  readDevelopmentPackageDescriptor,
} from "./release-assembly.mjs";

export const DEVELOPMENT_ASSEMBLY_REQUEST_SCHEMA = "bonni.development-release-assembly-request/v1";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_BASE_RECEIPT_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

function fail(code, detail = "", options) {
  throw new DevelopmentReleaseAssemblyError(code, detail, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("DEVELOPMENT_ASSEMBLY_REQUEST_INVALID", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("DEVELOPMENT_ASSEMBLY_REQUEST_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("DEVELOPMENT_ASSEMBLY_REQUEST_FIELD_REQUIRED", `${label}.${key}`);
  }
}

function normalizePath(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("DEVELOPMENT_ASSEMBLY_REQUEST_PATH_INVALID", label);
  }
  return path.resolve(value);
}

function stableDependencies(value) {
  return JSON.stringify([...value].sort((left, right) => {
    const candidateOrder = Buffer.compare(Buffer.from(left.candidateId), Buffer.from(right.candidateId));
    return candidateOrder || Buffer.compare(Buffer.from(left.packageSha256), Buffer.from(right.packageSha256));
  }));
}

export function parseDevelopmentAssemblyRequest(raw) {
  assertExactKeys(
    raw,
    new Set([
      "schema", "component", "productRoot", "baseRoot", "stagingRoot",
      "expectedFinalRoot", "keyFile",
    ]),
    new Set(["schema", "component", "productRoot", "stagingRoot"]),
    "request",
  );
  if (raw.schema !== DEVELOPMENT_ASSEMBLY_REQUEST_SCHEMA) {
    fail("DEVELOPMENT_ASSEMBLY_REQUEST_SCHEMA_UNSUPPORTED", String(raw.schema));
  }
  if (raw.component !== "SYSTEM") {
    fail("DEVELOPMENT_ASSEMBLY_REQUEST_COMPONENT_UNSUPPORTED", String(raw.component));
  }
  const productRoot = normalizePath(raw.productRoot, "request.productRoot");
  return Object.freeze({
    schema: DEVELOPMENT_ASSEMBLY_REQUEST_SCHEMA,
    component: "SYSTEM",
    productRoot,
    baseRoot: Object.hasOwn(raw, "baseRoot")
      ? normalizePath(raw.baseRoot, "request.baseRoot")
      : null,
    stagingRoot: normalizePath(raw.stagingRoot, "request.stagingRoot"),
    expectedFinalRoot: Object.hasOwn(raw, "expectedFinalRoot")
      ? normalizePath(raw.expectedFinalRoot, "request.expectedFinalRoot")
      : path.join(productRoot, "RUN_DEV", "CURRENT"),
    ...(Object.hasOwn(raw, "keyFile")
      ? { keyFile: normalizePath(raw.keyFile, "request.keyFile") }
      : {}),
  });
}

async function assertPlainDirectory(target, code) {
  let state;
  try {
    state = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") fail(code, target);
    throw error;
  }
  if (!state.isDirectory() || state.isSymbolicLink()) fail(code, target);
}

async function readVerifiedBaseReceipt(target) {
  let before;
  try {
    before = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") fail("DEVELOPMENT_ASSEMBLY_BASE_RECEIPT_MISSING", target);
    throw error;
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size <= 0
    || before.size > MAX_BASE_RECEIPT_BYTES
  ) fail("DEVELOPMENT_ASSEMBLY_BASE_RECEIPT_UNSAFE", target);
  const bytes = await fs.readFile(target);
  const after = await fs.lstat(target);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.nlink !== 1
    || after.size !== before.size
    || after.dev !== before.dev
    || after.ino !== before.ino
  ) fail("DEVELOPMENT_ASSEMBLY_BASE_RECEIPT_CHANGED", target);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("DEVELOPMENT_ASSEMBLY_BASE_RECEIPT_INVALID", target, { cause: error });
  }
  assertExactKeys(
    receipt,
    new Set(["schema", "version", "system"]),
    new Set(["schema", "version", "system"]),
    "baseReceipt",
  );
  assertExactKeys(
    receipt.system,
    new Set(["fileCount", "totalBytes", "treeSha256"]),
    new Set(["fileCount", "totalBytes", "treeSha256"]),
    "baseReceipt.system",
  );
  return receipt;
}

export async function resolveVerifiedDevelopmentAssemblyBase({ request, chain }) {
  if (!chain || typeof chain.baseVersion !== "string" || !VERSION.test(chain.baseVersion)) {
    fail("DEVELOPMENT_ASSEMBLY_BASE_VERSION_INVALID");
  }
  if (typeof chain.baseTreeSha256 !== "string" || !SHA256.test(chain.baseTreeSha256)) {
    fail("DEVELOPMENT_ASSEMBLY_BASE_TREE_HASH_INVALID");
  }
  const basesRoot = path.join(request.productRoot, "RUN_DEV", "BASES");
  const envelopeRoot = path.join(basesRoot, chain.baseVersion);
  const baseRoot = path.join(envelopeRoot, "SYSTEM");
  if (request.baseRoot !== null && path.resolve(request.baseRoot) !== path.resolve(baseRoot)) {
    fail("DEVELOPMENT_ASSEMBLY_BASE_ROOT_MISMATCH", request.baseRoot);
  }
  for (const directory of [
    request.productRoot,
    path.join(request.productRoot, "RUN_DEV"),
    basesRoot,
    envelopeRoot,
    baseRoot,
  ]) await assertPlainDirectory(directory, "DEVELOPMENT_ASSEMBLY_BASE_DIRECTORY_UNSAFE");
  const receipt = await readVerifiedBaseReceipt(path.join(envelopeRoot, "BASE.json"));
  const inventory = await collectDevelopmentTree(baseRoot);
  const totalBytes = inventory.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (
    receipt.schema !== "bonni.development-base/v1"
    || receipt.version !== chain.baseVersion
    || !Number.isSafeInteger(receipt.system.fileCount)
    || receipt.system.fileCount < 0
    || !Number.isSafeInteger(receipt.system.totalBytes)
    || receipt.system.totalBytes < 0
    || receipt.system.fileCount !== inventory.files.length
    || receipt.system.totalBytes !== totalBytes
    || receipt.system.treeSha256 !== inventory.treeSha256
    || chain.baseTreeSha256 !== inventory.treeSha256
  ) fail("DEVELOPMENT_ASSEMBLY_BASE_RECEIPT_MISMATCH", chain.baseVersion);
  return Object.freeze({ baseRoot, receipt, inventory });
}

async function readRequestFile(requestFile) {
  const resolved = path.resolve(requestFile);
  const state = await fs.lstat(resolved);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1 || state.size <= 0 || state.size > MAX_REQUEST_BYTES) {
    fail("DEVELOPMENT_ASSEMBLY_REQUEST_FILE_INVALID", resolved);
  }
  try {
    return parseDevelopmentAssemblyRequest(JSON.parse(await fs.readFile(resolved, "utf8")));
  } catch (error) {
    if (error instanceof DevelopmentReleaseAssemblyError) throw error;
    fail("DEVELOPMENT_ASSEMBLY_REQUEST_JSON_INVALID", resolved, { cause: error });
  }
}

async function loadVerifiedDescriptors(request, chain) {
  const descriptors = new Map();
  const loading = new Set();

  const load = async (candidateId, packageSha256) => {
    if (descriptors.has(candidateId)) {
      if (descriptors.get(candidateId).packageSha256 !== packageSha256) {
        fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_HASH_CONFLICT", candidateId);
      }
      return;
    }
    if (loading.has(candidateId)) fail("DEVELOPMENT_ASSEMBLY_DEPENDENCY_CYCLE", candidateId);
    if (typeof packageSha256 !== "string" || !SHA256.test(packageSha256)) {
      fail("DEVELOPMENT_ASSEMBLY_PACKAGE_HASH_INVALID", candidateId);
    }
    loading.add(candidateId);
    const verified = await readVerifiedDevelopmentReceipt({
      productRoot: request.productRoot,
      candidateId,
      packageSha256,
      ...(request.keyFile ? { keyFile: request.keyFile } : {}),
      verifyPackage: true,
    });
    if (verified.location.kind !== "package") {
      fail("DEVELOPMENT_ASSEMBLY_REQUIRED_PACKAGE_IN_TRASH", candidateId);
    }
    const packageDescriptor = await readDevelopmentPackageDescriptor(verified.location.path);
    const { receipt } = verified;
    if (
      packageDescriptor.candidateId !== candidateId
      || packageDescriptor.packageSha256 !== receipt.packageSha256
      || packageDescriptor.manifestSha256 !== receipt.manifestSha256
      || packageDescriptor.manifest.resultingTreeSha256 !== receipt.resultingTreeSha256
      || stableDependencies(packageDescriptor.manifest.requires) !== stableDependencies(receipt.requires)
    ) {
      await packageDescriptor.dispose();
      fail("DEVELOPMENT_ASSEMBLY_RECEIPT_PACKAGE_BINDING_MISMATCH", candidateId);
    }
    const descriptor = Object.freeze({
      ...packageDescriptor,
      status: receipt.status,
      receiptSha256: receipt.receiptSha256,
    });
    descriptors.set(candidateId, descriptor);
    for (const dependency of descriptor.manifest.requires) {
      await load(dependency.candidateId, dependency.packageSha256);
    }
    loading.delete(candidateId);
  };

  try {
    for (const entry of chain.entries) await load(entry.candidateId, entry.packageSha256);
    return descriptors;
  } catch (error) {
    await Promise.all([...descriptors.values()].map((entry) => entry.dispose().catch(() => {})));
    throw error;
  }
}

export async function assembleApprovedReleaseRequest(rawRequest) {
  const request = parseDevelopmentAssemblyRequest(rawRequest);
  const chain = await readApprovedDevelopmentChain({
    productRoot: request.productRoot,
    ...(request.keyFile ? { keyFile: request.keyFile } : {}),
    verifyPackages: true,
  });
  const base = await resolveVerifiedDevelopmentAssemblyBase({ request, chain });
  const descriptors = await loadVerifiedDescriptors(request, chain);
  try {
    return await assembleApprovedDevelopmentRelease({
      baseRoot: base.baseRoot,
      stagingRoot: request.stagingRoot,
      chain,
      packageDescriptors: descriptors,
      expectedFinalRoot: request.expectedFinalRoot,
    });
  } finally {
    await Promise.all([...descriptors.values()].map((entry) => entry.dispose().catch(() => {})));
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--request" || !argumentsList[1]) {
    fail("DEVELOPMENT_ASSEMBLY_ARGUMENTS_INVALID", "usage: --request <request.json>");
  }
  return argumentsList[1];
}

async function main() {
  const request = await readRequestFile(parseArguments(process.argv.slice(2)));
  const result = await assembleApprovedReleaseRequest(request);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "DEVELOPMENT_ASSEMBLY_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code, message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  });
}
