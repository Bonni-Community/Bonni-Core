import { createHash } from "node:crypto";

export const DEVELOPMENT_VERSIONING_SCHEMA = "bonni.development-versioning/v1";
export const DEVELOPMENT_PACKAGE_VERSIONED_SCHEMA = "bonni.development-package/v2";

const HASH = /^[a-f0-9]{64}$/u;
const CANDIDATE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const BASE_VERSION = /^\d+\.\d+\.\d+\+[a-z]$/u;
const BRANCH = /^[a-z]$/u;
const PATH = /^[^\\/\u0000-\u001f\u007f]+(?:\/[^\\/\u0000-\u001f\u007f]+)*$/u;

export class DevelopmentVersioningError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DevelopmentVersioningError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new DevelopmentVersioningError(code, detail);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function stableDevelopmentVersioningJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableDevelopmentVersioningJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableDevelopmentVersioningJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableDevelopmentVersioningJson(value)).digest("hex");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("DEVELOPMENT_VERSION_METADATA_INVALID", label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("DEVELOPMENT_VERSION_METADATA_UNKNOWN_FIELD", `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("DEVELOPMENT_VERSION_METADATA_FIELD_MISSING", `${label}.${key}`);
  }
}

function normalizeCandidate(value, label) {
  if (typeof value !== "string" || !CANDIDATE.test(value)) {
    fail("DEVELOPMENT_VERSION_METADATA_CANDIDATE_INVALID", label);
  }
  return value;
}

function normalizePath(value, label) {
  if (typeof value !== "string" || value !== value.normalize("NFC")
    || value.length < 1 || value.length > 4096 || !PATH.test(value)
    || value.startsWith("/") || value.endsWith("/") || value.includes("//")
    || /^[A-Za-z]:/u.test(value)) {
    fail("DEVELOPMENT_VERSION_METADATA_PATH_INVALID", `${label}:${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".."
    || segment.endsWith(".") || segment.endsWith(" ")
    || /[<>:"|?*]/u.test(segment))) {
    fail("DEVELOPMENT_VERSION_METADATA_PATH_UNSAFE", `${label}:${value}`);
  }
  return value;
}

function normalizeHash(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !HASH.test(value)) {
    fail("DEVELOPMENT_VERSION_METADATA_HASH_INVALID", label);
  }
  return value;
}

function normalizeDependencies(value, label = "dependencies") {
  if (!Array.isArray(value) || value.length > 10_000) {
    fail("DEVELOPMENT_VERSION_METADATA_DEPENDENCIES_INVALID", label);
  }
  const seen = new Set();
  const dependencies = value.map((entry, index) => {
    exactKeys(
      entry,
      new Set(["candidateId", "packageSha256"]),
      new Set(["candidateId", "packageSha256"]),
      `${label}[${index}]`,
    );
    const candidateId = normalizeCandidate(entry.candidateId, `${label}[${index}].candidateId`);
    const packageSha256 = normalizeHash(entry.packageSha256, `${label}[${index}].packageSha256`);
    if (seen.has(candidateId)) fail("DEVELOPMENT_VERSION_METADATA_DEPENDENCY_DUPLICATE", candidateId);
    seen.add(candidateId);
    return { candidateId, packageSha256 };
  });
  return dependencies.sort((left, right) => (
    bytewiseCompare(left.candidateId, right.candidateId)
    || bytewiseCompare(left.packageSha256, right.packageSha256)
  ));
}

function normalizeAction(value, label) {
  if (!["add", "replace", "delete"].includes(value)) {
    fail("DEVELOPMENT_VERSION_METADATA_ACTION_INVALID", label);
  }
  return value;
}

export function changedFilesFromDevelopmentOperations(operations, label = "operations") {
  if (!Array.isArray(operations)) fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILES_INVALID", label);
  const seen = new Set();
  const changedFiles = operations.map((operation, index) => {
    if (!isPlainObject(operation)) fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILES_INVALID", `${label}[${index}]`);
    const action = normalizeAction(operation.action, `${label}[${index}].action`);
    const path = normalizePath(operation.path, `${label}[${index}].path`);
    if (seen.has(path.toLowerCase())) fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILE_DUPLICATE", path);
    seen.add(path.toLowerCase());
    const baseSha256 = normalizeHash(
      operation.expectedPreviousSha256,
      `${label}[${index}].expectedPreviousSha256`,
      { nullable: action !== "add" ? false : true },
    );
    const resultSha256 = action === "delete"
      ? null
      : normalizeHash(operation.sha256, `${label}[${index}].sha256`);
    if (action === "add" && baseSha256 !== null) {
      fail("DEVELOPMENT_VERSION_METADATA_ADD_BASE_HASH_INVALID", path);
    }
    if (action !== "add" && baseSha256 === null) {
      fail("DEVELOPMENT_VERSION_METADATA_BASE_HASH_REQUIRED", path);
    }
    return { path, action, baseSha256, resultSha256 };
  });
  changedFiles.sort((left, right) => bytewiseCompare(left.path, right.path));
  return changedFiles;
}

function normalizeChangedFiles(value, label = "changedFiles") {
  if (!Array.isArray(value) || value.length > 100_000) {
    fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILES_INVALID", label);
  }
  const seen = new Set();
  const changedFiles = value.map((entry, index) => {
    exactKeys(
      entry,
      new Set(["path", "action", "baseSha256", "resultSha256"]),
      new Set(["path", "action", "baseSha256", "resultSha256"]),
      `${label}[${index}]`,
    );
    const path = normalizePath(entry.path, `${label}[${index}].path`);
    const pathKey = path.toLowerCase();
    if (seen.has(pathKey)) fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILE_DUPLICATE", path);
    seen.add(pathKey);
    const action = normalizeAction(entry.action, `${label}[${index}].action`);
    const baseSha256 = normalizeHash(entry.baseSha256, `${label}[${index}].baseSha256`, { nullable: true });
    const resultSha256 = normalizeHash(entry.resultSha256, `${label}[${index}].resultSha256`, { nullable: true });
    if (action === "add" && baseSha256 !== null) fail("DEVELOPMENT_VERSION_METADATA_ADD_BASE_HASH_INVALID", path);
    if (action === "delete" && resultSha256 !== null) fail("DEVELOPMENT_VERSION_METADATA_DELETE_RESULT_HASH_INVALID", path);
    if (action !== "add" && baseSha256 === null) fail("DEVELOPMENT_VERSION_METADATA_BASE_HASH_REQUIRED", path);
    if (action !== "delete" && resultSha256 === null) fail("DEVELOPMENT_VERSION_METADATA_RESULT_HASH_REQUIRED", path);
    return { path, action, baseSha256, resultSha256 };
  });
  changedFiles.sort((left, right) => bytewiseCompare(left.path, right.path));
  return changedFiles;
}

function normalizeConflict(value, label) {
  exactKeys(
    value,
    new Set(["path", "branches", "candidates"]),
    new Set(["path", "branches", "candidates"]),
    label,
  );
  const path = normalizePath(value.path, `${label}.path`);
  if (!Array.isArray(value.branches) || value.branches.length < 2 || value.branches.length > 26) {
    fail("DEVELOPMENT_VERSION_METADATA_CONFLICT_INVALID", `${label}.branches`);
  }
  const branches = [...new Set(value.branches.map((branch, index) => {
    if (typeof branch !== "string" || !BRANCH.test(branch)) {
      fail("DEVELOPMENT_VERSION_METADATA_BRANCH_INVALID", `${label}.branches[${index}]`);
    }
    return branch;
  }))].sort(bytewiseCompare);
  if (branches.length < 2) fail("DEVELOPMENT_VERSION_METADATA_CONFLICT_INVALID", path);
  if (!Array.isArray(value.candidates) || value.candidates.length < 2 || value.candidates.length > 256) {
    fail("DEVELOPMENT_VERSION_METADATA_CONFLICT_INVALID", `${label}.candidates`);
  }
  const candidates = [...new Set(value.candidates.map((candidate, index) => (
    normalizeCandidate(candidate, `${label}.candidates[${index}]`)
  )))].sort(bytewiseCompare);
  if (candidates.length < 2) fail("DEVELOPMENT_VERSION_METADATA_CONFLICT_INVALID", path);
  return { path, branches, candidates };
}

function normalizeConflicts(value, label = "conflicts") {
  if (!Array.isArray(value) || value.length > 100_000) {
    fail("DEVELOPMENT_VERSION_METADATA_CONFLICTS_INVALID", label);
  }
  const seen = new Set();
  const conflicts = value.map((entry, index) => {
    const normalized = normalizeConflict(entry, `${label}[${index}]`);
    if (seen.has(normalized.path.toLowerCase())) {
      fail("DEVELOPMENT_VERSION_METADATA_CONFLICT_DUPLICATE", normalized.path);
    }
    seen.add(normalized.path.toLowerCase());
    return normalized;
  });
  conflicts.sort((left, right) => bytewiseCompare(left.path, right.path));
  return conflicts;
}

export function normalizeDevelopmentIdentity(input, label = "development") {
  if (!isPlainObject(input)) fail("DEVELOPMENT_VERSION_METADATA_INVALID", label);
  const baseVersion = String(input.baseVersion || "").trim().toLowerCase();
  if (!BASE_VERSION.test(baseVersion)) {
    fail("DEVELOPMENT_VERSION_METADATA_BASE_VERSION_INVALID", `${label}.baseVersion`);
  }
  const branch = String(input.branch || input.developerBranch || "").trim().toLowerCase();
  if (!BRANCH.test(branch)) fail("DEVELOPMENT_VERSION_METADATA_BRANCH_INVALID", `${label}.branch`);
  const rawNumber = input.devNumber ?? input.dev;
  const devNumber = typeof rawNumber === "number" ? rawNumber : Number(String(rawNumber || ""));
  if (!Number.isSafeInteger(devNumber) || devNumber < 1 || devNumber > 9_999) {
    fail("DEVELOPMENT_VERSION_METADATA_DEV_NUMBER_INVALID", `${label}.devNumber`);
  }
  const displayVersion = `${baseVersion}-DEV.${devNumber}`;
  const suppliedDisplay = input.displayVersion ?? input.developmentVersion ?? input.targetVersion;
  if (suppliedDisplay !== undefined && String(suppliedDisplay).trim() !== displayVersion) {
    fail("DEVELOPMENT_VERSION_METADATA_DISPLAY_VERSION_MISMATCH", `${label}:${String(suppliedDisplay)}`);
  }
  return Object.freeze({
    baseVersion,
    branch,
    devNumber,
    displayVersion,
  });
}

export function normalizeDevelopmentMetadata(input, { requireChangedFiles = false } = {}) {
  if (!isPlainObject(input)) fail("DEVELOPMENT_VERSION_METADATA_INVALID");
  const identity = normalizeDevelopmentIdentity(input);
  const operationsChangedFiles = Array.isArray(input.operations)
    ? changedFilesFromDevelopmentOperations(input.operations)
    : null;
  const changedFiles = input.changedFiles === undefined
    ? (operationsChangedFiles || [])
    : normalizeChangedFiles(input.changedFiles);
  if (requireChangedFiles && input.changedFiles === undefined) {
    fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILES_REQUIRED");
  }
  if (operationsChangedFiles
    && stableDevelopmentVersioningJson(operationsChangedFiles)
      !== stableDevelopmentVersioningJson(changedFiles)) {
    fail("DEVELOPMENT_VERSION_METADATA_CHANGED_FILES_MISMATCH");
  }
  const requires = input.requires === undefined ? [] : normalizeDependencies(input.requires, "requires");
  const dependencies = input.dependencies === undefined
    ? requires
    : normalizeDependencies(input.dependencies, "dependencies");
  if (stableDevelopmentVersioningJson(requires) !== stableDevelopmentVersioningJson(dependencies)) {
    fail("DEVELOPMENT_VERSION_METADATA_DEPENDENCIES_MISMATCH");
  }
  const conflicts = normalizeConflicts(input.conflicts === undefined ? [] : input.conflicts);
  return Object.freeze({
    schema: DEVELOPMENT_VERSIONING_SCHEMA,
    ...identity,
    changedFiles: Object.freeze(changedFiles.map((entry) => Object.freeze(entry))),
    dependencies: Object.freeze(dependencies.map((entry) => Object.freeze(entry))),
    conflicts: Object.freeze(conflicts.map((entry) => Object.freeze(entry))),
  });
}

function normalizePackageForComparison(entry, index) {
  const manifest = isPlainObject(entry?.manifest) ? entry.manifest : entry;
  const nested = isPlainObject(entry?.development)
    ? entry.development
    : (isPlainObject(manifest?.development) ? manifest.development : {});
  const candidateId = normalizeCandidate(
    entry?.candidateId || manifest?.candidateId,
    `packages[${index}].candidateId`,
  );
  const packageSha256 = entry?.packageSha256 === undefined
    ? null
    : normalizeHash(entry.packageSha256, `packages[${index}].packageSha256`);
  const metadata = normalizeDevelopmentMetadata({
    ...manifest,
    ...(isPlainObject(entry?.development) ? entry.development : {}),
    baseVersion: entry?.baseVersion || nested.baseVersion || manifest?.baseVersion,
    branch: entry?.branch || nested.branch || manifest?.branch,
    devNumber: entry?.devNumber || nested.devNumber || manifest?.devNumber,
    displayVersion: entry?.displayVersion || nested.displayVersion || manifest?.displayVersion || manifest?.targetVersion,
    changedFiles: entry?.changedFiles || nested.changedFiles || manifest?.changedFiles,
    dependencies: entry?.dependencies || nested.dependencies || manifest?.dependencies || manifest?.requires,
    conflicts: entry?.conflicts || nested.conflicts || manifest?.conflicts || [],
    operations: manifest?.operations,
  });
  return { candidateId, packageSha256, metadata };
}

export function detectDevelopmentBranchConflicts(packages, { baseVersion = undefined } = {}) {
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 10_000) {
    fail("DEVELOPMENT_VERSION_METADATA_PACKAGES_INVALID");
  }
  const normalized = packages.map(normalizePackageForComparison);
  const expectedBase = baseVersion === undefined
    ? null
    : normalizeDevelopmentIdentity({ baseVersion, branch: "a", devNumber: 1 }).baseVersion;
  const stageKeys = new Set();
  for (const entry of normalized) {
    if (expectedBase && entry.metadata.baseVersion !== expectedBase) {
      fail("DEVELOPMENT_VERSION_BASE_CONFLICT", `${expectedBase}:${entry.metadata.baseVersion}`);
    }
    const stageKey = `${entry.metadata.branch}\0${entry.metadata.devNumber}`;
    if (stageKeys.has(stageKey)) {
      fail("DEVELOPMENT_VERSION_STAGE_DUPLICATE", stageKey);
    }
    stageKeys.add(stageKey);
  }
  const commonBaseVersion = expectedBase || normalized[0].metadata.baseVersion;
  if (normalized.some((entry) => entry.metadata.baseVersion !== commonBaseVersion)) {
    fail("DEVELOPMENT_VERSION_BASE_CONFLICT", commonBaseVersion);
  }

  const byPath = new Map();
  for (const entry of normalized) {
    for (const changed of entry.metadata.changedFiles) {
      const key = changed.path.toLowerCase();
      const writers = byPath.get(key) || [];
      writers.push({
        candidateId: entry.candidateId,
        packageSha256: entry.packageSha256,
        branch: entry.metadata.branch,
        devNumber: entry.metadata.devNumber,
        action: changed.action,
        baseSha256: changed.baseSha256,
        resultSha256: changed.resultSha256,
        path: changed.path,
      });
      byPath.set(key, writers);
    }
  }
  const changedFiles = [...byPath.values()].map((writers) => {
    writers.sort((left, right) => (
      bytewiseCompare(left.branch, right.branch)
      || left.devNumber - right.devNumber
      || bytewiseCompare(left.candidateId, right.candidateId)
    ));
    const branches = [...new Set(writers.map((writer) => writer.branch))].sort(bytewiseCompare);
    return {
      path: writers[0].path,
      branches,
      candidates: [...new Set(writers.map((writer) => writer.candidateId))].sort(bytewiseCompare),
      writers,
    };
  }).sort((left, right) => bytewiseCompare(left.path, right.path));
  const conflicts = changedFiles
    .filter((entry) => entry.branches.length > 1)
    .map((entry) => ({
      path: entry.path,
      branches: entry.branches,
      candidates: entry.candidates,
      writers: entry.writers,
    }));
  const declaredConflicts = normalized.flatMap((entry) => entry.metadata.conflicts);
  const conflictByPath = new Map(conflicts.map((entry) => [entry.path.toLowerCase(), entry]));
  for (const declared of declaredConflicts) {
    const key = declared.path.toLowerCase();
    if (!conflictByPath.has(key)) conflictByPath.set(key, declared);
  }
  const allConflicts = [...conflictByPath.values()].sort((left, right) => bytewiseCompare(left.path, right.path));
  const branches = [...new Set(normalized.map((entry) => entry.metadata.branch))]
    .sort(bytewiseCompare)
    .map((branch) => {
      const entries = normalized.filter((entry) => entry.metadata.branch === branch)
        .sort((left, right) => left.metadata.devNumber - right.metadata.devNumber);
      return {
        branch,
        devNumbers: entries.map((entry) => entry.metadata.devNumber),
        candidates: entries.map((entry) => entry.candidateId).sort(bytewiseCompare),
        changedFileCount: new Set(entries.flatMap((entry) => entry.metadata.changedFiles.map((file) => file.path.toLowerCase()))).size,
      };
    });
  const dependencies = [...new Map(normalized.flatMap((entry) => entry.metadata.dependencies)
    .map((dependency) => [dependency.candidateId, dependency])).values()]
    .sort((left, right) => bytewiseCompare(left.candidateId, right.candidateId));
  const core = {
    schema: DEVELOPMENT_VERSIONING_SCHEMA,
    baseVersion: commonBaseVersion,
    branches,
    changedFiles,
    dependencies,
    conflicts: allConflicts,
    mergeable: allConflicts.length === 0,
    autoMerge: allConflicts.length === 0,
  };
  return Object.freeze({ ...core, mergeSha256: digest(core) });
}

export function createDevelopmentMergeMetadata(packages, options = {}) {
  return detectDevelopmentBranchConflicts(packages, options);
}

export function normalizeDevelopmentMergeMetadata(value) {
  if (!isPlainObject(value)) fail("DEVELOPMENT_VERSION_METADATA_MERGE_INVALID");
  const required = [
    "schema", "baseVersion", "branches", "changedFiles", "dependencies", "conflicts",
    "mergeable", "autoMerge", "mergeSha256",
  ];
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail("DEVELOPMENT_VERSION_METADATA_MERGE_INVALID");
  }
  if (value.schema !== DEVELOPMENT_VERSIONING_SCHEMA
    || typeof value.mergeable !== "boolean"
    || typeof value.autoMerge !== "boolean"
    || value.mergeable !== (Array.isArray(value.conflicts) && value.conflicts.length === 0)
    || value.autoMerge !== value.mergeable
    || !HASH.test(value.mergeSha256)) {
    fail("DEVELOPMENT_VERSION_METADATA_MERGE_INVALID");
  }
  const baseVersion = String(value.baseVersion || "").trim().toLowerCase();
  if (!BASE_VERSION.test(baseVersion)) fail("DEVELOPMENT_VERSION_METADATA_BASE_VERSION_INVALID");
  if (!Array.isArray(value.branches) || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.dependencies) || !Array.isArray(value.conflicts)) {
    fail("DEVELOPMENT_VERSION_METADATA_MERGE_INVALID");
  }
  const core = { ...value };
  delete core.mergeSha256;
  if (digest(core) !== value.mergeSha256) {
    fail("DEVELOPMENT_VERSION_METADATA_MERGE_HASH_MISMATCH");
  }
  return Object.freeze({ ...value, baseVersion });
}
