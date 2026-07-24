export function bootGateTerminalIsSafe(result) {
  if (result?.busy) return false;
  if (result?.processed === false) return result.ok === true;
  const terminal = result?.result;
  if (terminal?.status === "completed") return result.ok === true;
  if (terminal?.status === "rolled-back") return terminal.rollback?.ok === true;
  if (terminal?.status !== "failed") return false;

  // A rejected or Candidate-only failure is safe for boot only when the
  // journal positively proves that no production cutover began. Missing
  // legacy flags are deliberately not interpreted as false.
  const flags = terminal.flags;
  return flags?.activePromoteStarted === false
    && flags?.activeOverlayCommitted === false
    && flags?.proxyGated === false
    && terminal.rollback?.attempted !== true
    && (flags.rollbackImagePinned === false
      || flags.canonicalActiveRestoredAfterLoad === true);
}
