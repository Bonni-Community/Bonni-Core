export {
  defaultSystemModules,
  listSystemModules,
  syncDefaultSystemModules,
} from "./core-module-registry.service.js";

export type {
  SystemModuleDefinition,
  SystemModuleSource,
} from "./core-module-registry.service.js";

export {
  findInstalledModule,
  listInstalledModules,
  recordModuleEvent,
  updateInstalledModuleStatus,
  upsertInstalledModuleFromManifest,
} from "./installed-module.repository.js";
