import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

function storageRootError(code, detail = "") {
  return Object.assign(new Error(detail ? `${code}:${detail}` : code), { code });
}

function configuredPath(value, currentDirectory, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("\u0000")) {
    throw storageRootError("PERSISTENT_STORAGE_ROOT_INVALID", label);
  }
  const resolved = path.resolve(currentDirectory, raw);
  if (resolved === path.parse(resolved).root) {
    throw storageRootError("PERSISTENT_STORAGE_ROOT_TOO_BROAD", label);
  }
  return resolved;
}

function assertSafeExistingDirectory(candidate, label) {
  if (!existsSync(candidate)) return false;
  const state = lstatSync(candidate);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw storageRootError("PERSISTENT_STORAGE_ROOT_UNSAFE", label);
  }
  return true;
}

function pathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Resolves the single persistent data root used by Core services in both the
 * container runtime and the local host runtime. An explicit BONNI_STORAGE_ROOT
 * is authoritative. The legacy sibling directory remains supported only when
 * it is unambiguous; two distinct implicit roots fail closed instead of
 * silently splitting data and backups.
 */
export function resolvePersistentStorageRoot({
  environment = process.env,
  currentDirectory = process.cwd(),
} = {}) {
  const configured = configuredPath(
    environment.BONNI_STORAGE_ROOT,
    currentDirectory,
    "BONNI_STORAGE_ROOT",
  );
  if (configured) {
    assertSafeExistingDirectory(configured, "BONNI_STORAGE_ROOT");
    return configured;
  }

  const local = path.resolve(currentDirectory, "storage");
  const legacySibling = path.resolve(currentDirectory, "../storage");
  const localExists = assertSafeExistingDirectory(local, "local");
  const siblingExists = assertSafeExistingDirectory(legacySibling, "legacy-sibling");

  if (localExists && siblingExists && local !== legacySibling) {
    throw storageRootError("PERSISTENT_STORAGE_ROOT_AMBIGUOUS");
  }
  return siblingExists ? legacySibling : local;
}

/**
 * Media is backup-safe only below the canonical persistent root. Keep the
 * existing MEDIA_STORAGE_ROOT override, but reject locations that backups and
 * restores cannot cover.
 */
export function resolvePersistentMediaStorageRoot(options = {}) {
  const environment = options.environment ?? process.env;
  const currentDirectory = options.currentDirectory ?? process.cwd();
  const persistentRoot = resolvePersistentStorageRoot({ environment, currentDirectory });
  const configured = configuredPath(
    environment.MEDIA_STORAGE_ROOT,
    currentDirectory,
    "MEDIA_STORAGE_ROOT",
  );
  const mediaRoot = configured || path.join(persistentRoot, "media");
  if (!pathInside(mediaRoot, persistentRoot)) {
    throw storageRootError("MEDIA_STORAGE_ROOT_OUTSIDE_PERSISTENT_STORAGE");
  }
  assertSafeExistingDirectory(mediaRoot, "MEDIA_STORAGE_ROOT");
  return mediaRoot;
}

