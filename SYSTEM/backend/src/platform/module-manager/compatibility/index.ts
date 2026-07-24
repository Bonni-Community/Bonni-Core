export {
  compareVersions,
  coreVersionRange,
  evaluateModuleCompatibility,
  getInstalledModulesCompatibilityForCoreVersion,
  getModuleCompatibility,
} from "./module-compatibility.service.js";
export type {
  ModuleCompatibilityResult,
  ModuleDependencyStatus,
  VersionComparison,
} from "./module-compatibility.service.js";
