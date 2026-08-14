import path from "node:path";

export function getProjectRoot() {
  return process.env.BONNI_PROJECT_ROOT
    ? path.resolve(process.env.BONNI_PROJECT_ROOT)
    : path.resolve(process.cwd(), "../..");
}

export function getRunSystemRoot() {
  return process.env.RUN_SYSTEM_ROOT
    ? path.resolve(process.env.RUN_SYSTEM_ROOT)
    : path.join(getProjectRoot(), "run_system");
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
