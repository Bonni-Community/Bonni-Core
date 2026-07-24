import {
  defaultSystemModules,
  listSystemModules,
  syncDefaultSystemModules,
} from "../../../platform/module-manager/registry/index.js";

export async function getSystemRegistry() {
  const modules = await listSystemModules();

  return {
    ok: true,
    area: "registry",
    defaults: defaultSystemModules,
    modules,
  };
}

export async function syncSystemRegistry() {
  const result = await syncDefaultSystemModules();
  const modules = await listSystemModules();

  return {
    ...result,
    ok: true,
    modules,
  };
}

export async function runSystemRegistrySyncTool() {
  return syncSystemRegistry();
}
