import type { RegisteredRuntimeModule } from "../loader/index.js";

/** Frontend-only modules may be skipped; declared backend modules must load. */
export function isRuntimeActivationReady(
  backendEntry: string | null | undefined,
  runtimeStatus: RegisteredRuntimeModule["status"],
) {
  return backendEntry ? runtimeStatus === "loaded" : runtimeStatus !== "error";
}
