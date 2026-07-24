export {
  getRuntimeSurfaceLabel,
  getSystemRuntimeConfig,
  type SystemRuntimeConfig,
  type SystemRuntimeSlotRole,
} from "./runtime.config.js";
export {
  getRuntimeLiveStatus,
  getRuntimeReadyStatus,
  type RuntimeHealthState,
} from "./runtime.status.js";

export {
  assertDatabaseRuntimeRequired,
  getRuntimeJsonFallbackStatus,
  installedRuntimeModules,
  probeRuntimeDatabase,
  readInstalledRuntimeJson,
  readRuntimeJson,
  resolveRuntimeJsonSlot,
  shouldUseRuntimeJsonFallback,
  type RuntimeJsonFallbackStatus,
} from "./runtime-json-fallback.service.js";
