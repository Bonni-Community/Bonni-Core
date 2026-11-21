/** Frontend-only modules may be skipped; declared backend modules must load. */
export function isRuntimeActivationReady(backendEntry, runtimeStatus) {
    return backendEntry ? runtimeStatus === "loaded" : runtimeStatus !== "error";
}
