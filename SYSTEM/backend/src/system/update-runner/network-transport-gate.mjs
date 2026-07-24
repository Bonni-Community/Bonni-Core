import fs from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, writeJsonAtomic } from "./io.mjs";

export const NETWORK_TRANSPORT_GATE_PROTOCOL = "bonni-update-network-transport-gate/1";

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function closeNetworkTransportGate(file) {
  const directory = path.dirname(file);
  await ensureDirectory(directory);
  try {
    await fs.unlink(file);
    await syncDirectory(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function openNetworkTransportGate(file, {
  clock = () => new Date(),
  reason,
  runnerVersion,
} = {}) {
  const openedAt = clock().toISOString();
  if (!Number.isFinite(Date.parse(openedAt))) {
    throw new Error("NETWORK_TRANSPORT_GATE_CLOCK_INVALID");
  }
  const cleanReason = String(reason || "").trim();
  const cleanRunnerVersion = String(runnerVersion || "").trim();
  if (!cleanReason || cleanReason.length > 120) {
    throw new Error("NETWORK_TRANSPORT_GATE_REASON_INVALID");
  }
  if (!cleanRunnerVersion || cleanRunnerVersion.length > 80) {
    throw new Error("NETWORK_TRANSPORT_GATE_RUNNER_VERSION_INVALID");
  }
  await writeJsonAtomic(file, {
    protocol: NETWORK_TRANSPORT_GATE_PROTOCOL,
    schemaVersion: 1,
    state: "open",
    openedAt,
    reason: cleanReason,
    runnerVersion: cleanRunnerVersion,
  });
}
