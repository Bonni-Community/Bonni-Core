export type LocalSourceLifecycleGate = {
  blocksUpdates: boolean;
  holdUntil?: string | null;
};

export type LocalSourceRunnerLifecycleGate = {
  heartbeatFresh: boolean;
  lifecycleAuthority: "verified" | "absent" | "invalid";
  deploymentLifecycle: LocalSourceLifecycleGate;
};

export type LocalSourceLifecycleContext = {
  localLifecycleExpected?: boolean;
};

const MISSING_EXPECTED_LOCAL_LIFECYCLE = Object.freeze({
  blocksUpdates: true,
  holdUntil: null,
  state: "blocked",
  mode: "local-source",
  blockReason: "Der beleggebundene lokale Deployment-Lifecycle fehlt. Folgeupdates bleiben sicher gesperrt.",
  canFinalize: false,
  canRollback: false,
});

export function localSourceVersionRequiresLifecycle(value: unknown) {
  const revision = typeof value === "string"
    ? value.match(/^\d+\.\d+\.\d+\+([A-Za-z])(?:[.-]|$)/u)?.[1]?.toLowerCase()
    : null;
  return Boolean(revision && revision >= "b");
}

/**
 * Local Source updates and signed OCI deployments have independent runners.
 * Engine ownership is established by the existence of a valid local receipt,
 * not by that receipt's current blocksUpdates value.
 */
export function resolveLocalSourceDeploymentLifecycle(
  localLifecycle: LocalSourceLifecycleGate | null,
  runner: LocalSourceRunnerLifecycleGate,
  context: LocalSourceLifecycleContext = {},
): LocalSourceLifecycleGate | null {
  // A finalized or rolled-back receipt still identifies the local engine. It
  // must not inherit a stale or unrelated Docker lifecycle afterwards.
  if (localLifecycle) return localLifecycle;

  // From +b onward the active local source receipt promises an accompanying
  // lifecycle. Its disappearance is corruption, never a legacy bootstrap.
  if (context.localLifecycleExpected) return MISSING_EXPECTED_LOCAL_LIFECYCLE;

  if (runner.lifecycleAuthority === "verified") {
    return runner.deploymentLifecycle;
  }

  // An invalid runner receipt may hide a real hold and must never be ignored.
  if (runner.lifecycleAuthority === "invalid") return runner.deploymentLifecycle;

  // A live Docker runner without its mandatory lifecycle receipt is also an
  // inconsistent, fail-closed state. Only an absent and unowned Docker path is
  // irrelevant to the local Windows/source supervisor.
  if (runner.heartbeatFresh) return runner.deploymentLifecycle;
  return null;
}
