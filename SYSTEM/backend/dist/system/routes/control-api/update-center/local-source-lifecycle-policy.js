const MISSING_EXPECTED_LOCAL_LIFECYCLE = Object.freeze({
    blocksUpdates: true,
    holdUntil: null,
    state: "blocked",
    mode: "local-source",
    blockReason: "Der beleggebundene lokale Deployment-Lifecycle fehlt. Folgeupdates bleiben sicher gesperrt.",
    canFinalize: false,
    canRollback: false,
});
const INVALID_LOCAL_LIFECYCLE = Object.freeze({
    blocksUpdates: true,
    holdUntil: null,
    state: "blocked",
    mode: "local-source",
    blockReason: "Der lokale Deployment-Lifecycle ist widersprüchlich. Folgeupdates bleiben sicher gesperrt.",
    canFinalize: false,
    canRollback: false,
});
function validLocalLifecycleGate(value) {
    const state = value.status || value.state;
    if (!["holding", "rolling-back", "rolled-back", "finalized"].includes(String(state || ""))
        || (value.status !== undefined && value.state !== undefined && value.status !== value.state)
        || value.mode !== "local-source"
        || !Number.isFinite(Date.parse(String(value.holdUntil || ""))))
        return false;
    return ["holding", "rolling-back"].includes(String(state))
        ? value.blocksUpdates === true && typeof value.blockReason === "string" && Boolean(value.blockReason)
        : value.blocksUpdates === false && value.blockReason === null;
}
export function localSourceVersionRequiresLifecycle(value) {
    if (typeof value !== "string")
        return false;
    const revision = value.match(/^\d+\.\d+\.\d+\+([A-Za-z]+)(?:[.-]|$)/u)?.[1];
    if (!revision)
        return false;
    // Only the first historic source-update bootstrap predates lifecycle
    // receipts. Every later Bonni maintenance revision, including a new +a
    // line, must create the ordinary hold and finalization receipt.
    return value.toLowerCase() !== "0.1.19+a";
}
/**
 * Local Source updates and signed OCI deployments have independent runners.
 * Engine ownership is established by the existence of a valid local receipt,
 * not by that receipt's current blocksUpdates value.
 */
export function resolveLocalSourceDeploymentLifecycle(localLifecycle, runner, context = {}) {
    // A finalized or rolled-back receipt still identifies the local engine. It
    // must not inherit a stale or unrelated Docker lifecycle afterwards.
    if (localLifecycle) {
        return validLocalLifecycleGate(localLifecycle) ? localLifecycle : INVALID_LOCAL_LIFECYCLE;
    }
    // Every maintenance build except the exact historic 0.1.19+a bootstrap
    // promises an accompanying lifecycle. Its disappearance is corruption.
    if (context.localLifecycleExpected)
        return MISSING_EXPECTED_LOCAL_LIFECYCLE;
    if (runner.lifecycleAuthority === "verified") {
        return runner.deploymentLifecycle;
    }
    // An invalid runner receipt may hide a real hold and must never be ignored.
    if (runner.lifecycleAuthority === "invalid")
        return runner.deploymentLifecycle;
    // A live Docker runner without its mandatory lifecycle receipt is also an
    // inconsistent, fail-closed state. Only an absent and unowned Docker path is
    // irrelevant to the local Windows/source supervisor.
    if (runner.heartbeatFresh)
        return runner.deploymentLifecycle;
    return null;
}
