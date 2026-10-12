import path from "node:path";

function configuredRoot(name: "BONNI_PROGRAM_ROOT" | "BONNI_PRODUCT_ROOT") {
  const value = String(process.env[name] || "").trim();
  if (!value) return null;
  if (value.includes("\u0000") || !path.isAbsolute(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return path.resolve(value);
}

function configuredAbsolutePath(name: "BONNI_RUNTIME_STATE_ROOT") {
  const value = String(process.env[name] || "").trim();
  if (!value) return null;
  if (value.includes("\u0000") || !path.isAbsolute(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return path.resolve(value);
}

/**
 * Root of the immutable program generation that contains SYSTEM/backend.
 * BONNI_PROJECT_ROOT remains the backwards-compatible name for this code root.
 */
export function getProgramRoot() {
  const configured = configuredRoot("BONNI_PROGRAM_ROOT");
  if (configured) return configured;
  return process.env.BONNI_PROJECT_ROOT
    ? path.resolve(process.env.BONNI_PROJECT_ROOT)
    : path.resolve(process.cwd(), "../..");
}

export function getProjectRoot() {
  return getProgramRoot();
}

/**
 * Stable installation root that owns UPDATE and persistent lifecycle state.
 * Legacy installations without an explicit product root keep the old layout.
 */
export function getProductRoot() {
  return configuredRoot("BONNI_PRODUCT_ROOT") || getProjectRoot();
}

/**
 * Mutable runtime state used by the selected backend generation.
 *
 * BONNI_RUNTIME_STATE_ROOT is the unambiguous v2 name. RUN_SYSTEM_ROOT is
 * retained solely as the legacy alias used by existing modules and packages.
 * Deliberately keep the legacy product/run_system default: a backend started
 * directly from SYSTEM must not infer the RUN_SYSTEM/runtime v2 layout before
 * the verified bootstrap has selected and exported that layout.
 */
export function getRuntimeStateRoot() {
  const configured = configuredAbsolutePath("BONNI_RUNTIME_STATE_ROOT");
  if (configured) return configured;
  return process.env.RUN_SYSTEM_ROOT
    ? path.resolve(process.env.RUN_SYSTEM_ROOT)
    : path.join(getProductRoot(), "run_system");
}

export function getRunSystemRoot() {
  return getRuntimeStateRoot();
}

export function getRunSystemSystemRoot() {
  return process.env.RUN_SYSTEM_SYSTEM_ROOT
    ? path.resolve(process.env.RUN_SYSTEM_SYSTEM_ROOT)
    : path.join(getRunSystemRoot(), "system");
}

export function getRunSystemStorageRoot() {
  return process.env.RUN_SYSTEM_STORAGE_ROOT
    ? path.resolve(process.env.RUN_SYSTEM_STORAGE_ROOT)
    : path.join(getRunSystemRoot(), "storage");
}

export function getRunSystemArchivRoot() {
  return process.env.RUN_SYSTEM_ARCHIV_ROOT
    ? path.resolve(process.env.RUN_SYSTEM_ARCHIV_ROOT)
    : path.join(getRunSystemRoot(), "archiv");
}
