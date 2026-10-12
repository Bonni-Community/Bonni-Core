#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDevelopmentCleanupPlan,
  emptyDevelopmentTrash,
  executeDevelopmentCleanup,
  initializeDevelopmentLocalKey,
  initializeDevelopmentStore,
  listDevelopmentPackages,
  listDevelopmentTrash,
  readApprovedDevelopmentChain,
  readDevelopmentTestReady,
  readVerifiedDevelopmentReceipt,
  recordDevelopmentReview,
  registerDevelopmentPackage,
  restoreDevelopmentPackage,
  stageDevelopmentPackageForTest,
  stageDevelopmentPackageSetForTest,
} from "./development-package-store.mjs";
import { exportDevelopmentTestTree } from "./development-export.mjs";

const ACTIONS = new Set([
  "init",
  "import",
  "list",
  "stage-test",
  "stage-test-set",
  "preview-test-set",
  "export-test-tree",
  "review",
  "cleanup-plan",
  "cleanup-execute",
  "restore",
  "trash-empty",
]);
const VALUE_OPTIONS = new Set([
  "--product-root",
  "--key-file",
  "--zip",
  "--candidate-id",
  "--package-sha256",
  "--reviewed-by",
  "--note",
  "--status",
  "--base-root",
  "--base-version",
  "--preview-sha256",
  "--test-system",
  "--output",
  "--final-tree-sha256",
  "--build-id",
  "--target-version",
  "--branch",
  "--dev-number",
  "--plan-sha256",
  "--trash-id",
  "--retention-days",
]);
const REPEATABLE_OPTIONS = new Set([
  "--active",
  "--open",
  "--prepared-release",
  "--discard-pending",
  "--member",
  "--dependency",
]);
const FLAG_OPTIONS = new Set(["--verify", "--force", "--independent-base"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

class DevelopmentStoreCliError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DevelopmentStoreCliError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new DevelopmentStoreCliError(code, detail);
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (!ACTIONS.has(action)) fail("DEVELOPMENT_CLI_ACTION_INVALID", String(action || ""));
  const values = new Map();
  const repeated = new Map([...REPEATABLE_OPTIONS].map((option) => [option, []]));
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) fail("DEVELOPMENT_CLI_OPTION_DUPLICATE", option);
      flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option) && !REPEATABLE_OPTIONS.has(option)) {
      fail("DEVELOPMENT_CLI_OPTION_UNKNOWN", option);
    }
    const value = rest[++index];
    if (!value || value.startsWith("--")) fail("DEVELOPMENT_CLI_OPTION_VALUE_MISSING", option);
    if (REPEATABLE_OPTIONS.has(option)) {
      repeated.get(option).push(value);
    } else {
      if (values.has(option)) fail("DEVELOPMENT_CLI_OPTION_DUPLICATE", option);
      values.set(option, value);
    }
  }
  const productRoot = values.get("--product-root");
  if (!productRoot) fail("DEVELOPMENT_CLI_PRODUCT_ROOT_REQUIRED");
  return {
    action,
    productRoot: path.resolve(productRoot),
    keyFile: values.has("--key-file") ? path.resolve(values.get("--key-file")) : undefined,
    values,
    repeated,
    flags,
  };
}

function required(options, name) {
  const value = options.values.get(name);
  if (!value) fail("DEVELOPMENT_CLI_OPTION_REQUIRED", name);
  return value;
}

function optionalHash(options, name) {
  const value = options.values.get(name);
  if (value !== undefined && !HASH_PATTERN.test(value)) fail("DEVELOPMENT_CLI_HASH_INVALID", name);
  return value;
}

function common(options) {
  return {
    productRoot: options.productRoot,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
  };
}

function createProgressReporter() {
  let sequence = 0;
  let lastAt = 0;
  let lastPhase = "";
  return (entry) => {
    const now = Date.now();
    if (entry.phase === lastPhase && entry.files !== entry.total && now - lastAt < 500) return;
    lastAt = now;
    lastPhase = entry.phase;
    process.stderr.write(`BONNI_PROGRESS ${JSON.stringify({ ...entry, sequence: ++sequence })}\n`);
  };
}

function parseMember(value) {
  const separator = value.lastIndexOf("@");
  if (separator < 1) fail("DEVELOPMENT_CLI_MEMBER_INVALID", value);
  const candidateId = value.slice(0, separator);
  const packageSha256 = value.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(candidateId)
    || !HASH_PATTERN.test(packageSha256)) {
    fail("DEVELOPMENT_CLI_MEMBER_INVALID", value);
  }
  return { candidateId, packageSha256 };
}

function packageSummary(result) {
  return {
    candidateId: result.receipt.candidateId,
    packageSha256: result.receipt.packageSha256,
    ...(result.receipt.development ? { targetVersion: result.receipt.development.displayVersion } : {}),
    status: result.receipt.status,
    receiptSha256: result.receipt.receiptSha256,
    resultingTreeSha256: result.receipt.resultingTreeSha256,
    requires: result.receipt.requires,
    ...(result.receipt.development ? {
      baseVersion: result.receipt.development.baseVersion,
      branch: result.receipt.development.branch,
      devNumber: result.receipt.development.devNumber,
      displayVersion: result.receipt.development.displayVersion,
      changedFiles: result.receipt.development.changedFiles,
      dependencies: result.receipt.development.dependencies,
      conflicts: result.receipt.development.conflicts,
      development: result.receipt.development,
    } : {}),
    idempotent: Boolean(result.idempotent),
  };
}

async function execute(options) {
  const base = common(options);
  switch (options.action) {
    case "init": {
      await initializeDevelopmentStore(base);
      const key = await initializeDevelopmentLocalKey(base);
      return { initialized: true, localReviewKeyCreated: key.created };
    }
    case "import": {
      const result = await registerDevelopmentPackage({
        ...base,
        zipPath: path.resolve(required(options, "--zip")),
        ...(options.values.has("--candidate-id")
          ? { candidateId: options.values.get("--candidate-id") }
          : {}),
        reviewedBy: options.values.get("--reviewed-by") || "technical-admin",
        note: options.values.get("--note") || "",
      });
      return packageSummary(result);
    }
    case "list": {
      const verifyPackages = options.flags.has("--verify");
      return {
        candidates: await listDevelopmentPackages({
          ...base,
          verifyPackages,
        }),
        chain: await readApprovedDevelopmentChain({
          ...base,
          verifyPackages,
          required: false,
        }),
        trash: await listDevelopmentTrash({
          ...base,
          verifyPackages,
        }),
      };
    }
    case "stage-test": {
      return stageDevelopmentPackageForTest({
        ...base,
        candidateId: required(options, "--candidate-id"),
        packageSha256: optionalHash(options, "--package-sha256"),
        baseVersion: options.values.get("--base-version"),
        independentBase: options.flags.has("--independent-base"),
        ...(options.values.has("--base-root")
          ? { baseRoot: path.resolve(options.values.get("--base-root")) }
          : {}),
        onProgress: createProgressReporter(),
      });
    }
    case "preview-test-set":
    case "stage-test-set": {
      const members = options.repeated.get("--member").map(parseMember);
      if (!members.length) fail("DEVELOPMENT_CLI_OPTION_REQUIRED", "--member");
      return stageDevelopmentPackageSetForTest({
        ...base,
        packageRefs: members,
        previewOnly: options.action === "preview-test-set",
        expectedPreviewSha256: options.values.get("--preview-sha256"),
        baseVersion: options.values.get("--base-version"),
        independentBase: options.flags.has("--independent-base"),
        ...(options.values.has("--base-root")
          ? { baseRoot: path.resolve(options.values.get("--base-root")) }
          : {}),
        onProgress: createProgressReporter(),
      });
    }
    case "export-test-tree": {
      const members = options.repeated.get("--member");
      if (!members.length) fail("DEVELOPMENT_CLI_OPTION_REQUIRED", "--member");
      return exportDevelopmentTestTree({
        onProgress: createProgressReporter(),
        ...base,
        testSystem: path.resolve(required(options, "--test-system")),
        baseRoot: path.resolve(required(options, "--base-root")),
        baseVersion: required(options, "--base-version"),
        outputFile: path.resolve(required(options, "--output")),
        finalTreeSha256: optionalHash(options, "--final-tree-sha256"),
        buildId: options.values.get("--build-id"),
        targetVersion: options.values.get("--target-version"),
        branch: options.values.get("--branch"),
        devNumber: options.values.has("--dev-number")
          ? Number(options.values.get("--dev-number"))
          : undefined,
        dependencies: options.repeated.get("--dependency").map(parseMember),
        members,
      });
    }
    case "review": {
      const candidateId = required(options, "--candidate-id");
      const packageSha256 = optionalHash(options, "--package-sha256");
      const status = required(options, "--status");
      let approval = {};
      if (status === "approved") {
        const candidate = await readVerifiedDevelopmentReceipt({
          ...base,
          candidateId,
          packageSha256,
        });
        const ready = await readDevelopmentTestReady({
          ...base,
          candidateId,
          packageSha256: candidate.receipt.packageSha256,
        });
        approval = {
          targetVersion: ready.receipt.targetVersion,
          baseVersion: ready.receipt.baseVersion,
          baseTreeSha256: ready.receipt.baseTreeSha256,
        };
      }
      const result = await recordDevelopmentReview({
        ...base,
        candidateId,
        packageSha256,
        status,
        reviewedBy: required(options, "--reviewed-by"),
        note: options.values.get("--note") || "",
        ...approval,
      });
      return {
        ...packageSummary(result),
        chainSha256: result.chain?.chainSha256 || null,
        currentTreeSha256: result.promotion?.finalTreeSha256 || null,
      };
    }
    case "cleanup-plan": {
      return createDevelopmentCleanupPlan({
        ...base,
        activeCandidateIds: options.repeated.get("--active"),
        openCandidateIds: options.repeated.get("--open"),
        preparedReleaseCandidateIds: options.repeated.get("--prepared-release"),
        discardPendingCandidateIds: options.repeated.get("--discard-pending"),
        persist: true,
      });
    }
    case "cleanup-execute": {
      return executeDevelopmentCleanup({
        ...base,
        expectedPlanSha256: optionalHash(options, "--plan-sha256"),
      });
    }
    case "restore": {
      const restored = await restoreDevelopmentPackage({
        ...base,
        trashId: required(options, "--trash-id"),
      });
      return {
        candidateId: restored.candidateId,
        packageSha256: restored.packageSha256,
        status: restored.status,
        testRestored: restored.testRestored,
      };
    }
    case "trash-empty": {
      const rawDays = options.values.get("--retention-days") ?? "14";
      if (!/^[0-9]{1,5}$/u.test(rawDays)) fail("DEVELOPMENT_CLI_RETENTION_DAYS_INVALID");
      return emptyDevelopmentTrash({
        ...base,
        retentionMs: Number(rawDays) * 24 * 60 * 60_000,
        force: options.flags.has("--force"),
      });
    }
    default:
      fail("DEVELOPMENT_CLI_ACTION_INVALID", options.action);
  }
}

export async function runDevelopmentPackageStoreCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.action !== "init") {
    await initializeDevelopmentStore(common(options));
  }
  return execute(options);
}

async function main() {
  try {
    const result = await runDevelopmentPackageStoreCli();
    process.stdout.write(`${JSON.stringify({ ok: true, action: process.argv[2], ...result })}\n`);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "DEVELOPMENT_CLI_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code, message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
