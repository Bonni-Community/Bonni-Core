import path from "node:path";

const CORE_COMPONENTS = new Map([
  ["system/backend", "bonni-core-backend"],
  ["system/frontend", "bonni-core-frontend"],
]);

const DATABASE_CONTRACT_ROOTS = [
  "system/backend/prisma",
  "system/backend/ops/migrations",
  "system/backend/scripts/database",
];
const PRISMA_CONTRACT_ROOT = "system/backend/prisma";
const OPS_MIGRATIONS_ROOT = "system/backend/ops/migrations";
const OPS_RUNNER_PATH = "system/backend/scripts/database/run-ops-migrations.mjs";
const OPS_MIGRATION_PATH_PATTERN = /^system\/backend\/ops\/migrations\/\d{8}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.sql$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const MUTABLE_INSTALLATION_ROOTS = [
  "backup",
  "run",
  "run_system",
  "storage",
  "update",
  "system/.bonni-source-update",
  "system/backend/backups",
  "system/backend/data",
  "system/backend/logs",
  "system/backend/run_system",
  "system/backend/storage",
  "system/backend/uploads",
  "system/backend/updates",
  "system/frontend/uploads",
  "system/frontend/public/uploads",
];

function compatibilityError(code, detail = "") {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function normalizeManifestPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.isAbsolute(value)) {
    throw compatibilityError("LOCAL_CANDIDATE_MANIFEST_PATH_INVALID", label);
  }
  const normalized = value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw compatibilityError("LOCAL_CANDIDATE_MANIFEST_PATH_INVALID", label);
  }
  return normalized;
}

function inside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function changed(entry) {
  return entry.expectedPreviousSha256 !== entry.sha256;
}

/**
 * Native RUN candidates may promote code-only updates and an explicitly
 * classified append-only Ops expand chain. Candidate databases remain
 * disposable test copies; production receives only the exact packaged Ops SQL
 * through the locked/hash-tracked runner after Candidate health succeeds.
 */
export function assertLocalCandidateCompatibility(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw compatibilityError("LOCAL_CANDIDATE_MANIFEST_INVALID");
  }
  if (!Array.isArray(manifest.components) || !Array.isArray(manifest.files) || !Array.isArray(manifest.delete)) {
    throw compatibilityError("LOCAL_CANDIDATE_MANIFEST_INVALID");
  }

  const components = new Set();
  for (const [index, component] of manifest.components.entries()) {
    const componentPath = normalizeManifestPath(component?.path, `components[${index}]`);
    const expectedKey = CORE_COMPONENTS.get(componentPath);
    if (!expectedKey || component?.key !== expectedKey || component?.mode !== "managed") {
      throw compatibilityError("LOCAL_CANDIDATE_CORE_ONLY_REQUIRED", component?.path || String(index));
    }
    if (components.has(componentPath)) {
      throw compatibilityError("LOCAL_CANDIDATE_COMPONENT_DUPLICATE", componentPath);
    }
    components.add(componentPath);
  }
  if (components.size !== CORE_COMPONENTS.size) {
    throw compatibilityError("LOCAL_CANDIDATE_CORE_COMPONENT_SET_INCOMPLETE");
  }

  const changedPrismaPaths = [];
  const changedOpsMigrations = [];
  const unsupportedDatabasePaths = [];
  for (const [index, entry] of manifest.files.entries()) {
    const filePath = normalizeManifestPath(entry?.path, `files[${index}]`);
    if (MUTABLE_INSTALLATION_ROOTS.some((root) => inside(filePath, root))) {
      throw compatibilityError("LOCAL_CANDIDATE_MUTABLE_PATH_FORBIDDEN", entry.path);
    }
    if (!changed(entry)) continue;
    if (!SHA256_PATTERN.test(String(entry?.sha256 || ""))
      || !(entry?.expectedPreviousSha256 === null
        || SHA256_PATTERN.test(String(entry?.expectedPreviousSha256 || "")))) {
      throw compatibilityError("LOCAL_CANDIDATE_MANIFEST_HASH_INVALID", entry.path);
    }
    if (inside(filePath, OPS_MIGRATIONS_ROOT)) {
      if (OPS_MIGRATION_PATH_PATTERN.test(filePath) && entry.expectedPreviousSha256 === null) {
        changedOpsMigrations.push({ path: filePath, sha256: entry.sha256 });
      }
      else unsupportedDatabasePaths.push(entry.path);
    } else if (inside(filePath, PRISMA_CONTRACT_ROOT)) {
      changedPrismaPaths.push(entry.path);
    } else if (inside(filePath, "system/backend/scripts/database")) {
      if (filePath !== OPS_RUNNER_PATH || entry.expectedPreviousSha256 !== null) {
        unsupportedDatabasePaths.push(entry.path);
      }
    }
  }
  for (const [index, entry] of manifest.delete.entries()) {
    const filePath = normalizeManifestPath(entry?.path, `delete[${index}]`);
    if (MUTABLE_INSTALLATION_ROOTS.some((root) => inside(filePath, root))) {
      throw compatibilityError("LOCAL_CANDIDATE_MUTABLE_PATH_FORBIDDEN", entry.path);
    }
    if (DATABASE_CONTRACT_ROOTS.some((root) => inside(filePath, root))) {
      unsupportedDatabasePaths.push(entry.path);
    }
  }
  const migrationContractIncomplete = Boolean(changedPrismaPaths.length)
    !== Boolean(changedOpsMigrations.length);
  if (unsupportedDatabasePaths.length || migrationContractIncomplete) {
    const blockedPaths = [
      ...unsupportedDatabasePaths,
      ...(!changedOpsMigrations.length ? changedPrismaPaths : []),
      ...(!changedPrismaPaths.length ? changedOpsMigrations.map(({ path: migrationPath }) => migrationPath) : []),
    ];
    throw compatibilityError(
      "LOCAL_CANDIDATE_DATABASE_CONTRACT_REQUIRED",
      blockedPaths.sort((left, right) => left.localeCompare(right, "en")).join(","),
    );
  }

  if (changedOpsMigrations.length) {
    const sortedMigrations = changedOpsMigrations.sort((left, right) => left.path.localeCompare(right.path));
    return Object.freeze({
      mode: "expand-contract",
      migrationCompatibility: "expand-contract",
      opsMigrations: sortedMigrations.map(({ path: migrationPath }) => migrationPath),
      opsMigrationSha256: Object.freeze(Object.fromEntries(
        sortedMigrations.map(({ path: migrationPath, sha256: digest }) => [migrationPath, digest]),
      )),
      components: [...components].sort(),
    });
  }

  return Object.freeze({
    mode: "code-only",
    migrationCompatibility: "none",
    components: [...components].sort(),
  });
}
