import {
  buildSlotLaunchPlan,
  ensureRunSlotFoundation,
  projectRoot,
  readSlotPointers,
  runContainerRoot,
  verifyProgramSlot,
} from "./runcontainer-lib.mjs";

const runRoot = runContainerRoot();
await ensureRunSlotFoundation({ runRoot });
const pointers = await readSlotPointers({ runRoot });
const slots = {};

for (const role of ["active", "candidate", "previous"]) {
  if (!pointers.roles[role]) {
    slots[role] = null;
    continue;
  }
  const verified = await verifyProgramSlot(role, { runRoot });
  const launch = await buildSlotLaunchPlan(role, { runRoot, installationRoot: projectRoot() });
  slots[role] = {
    ok: verified.ok,
    slotId: verified.receipt.slotId,
    version: verified.receipt.source.version,
    treeSha256: verified.receipt.treeSha256,
    programRoot: launch.programRoot,
    backendRoot: launch.backendRoot,
    ports: launch.health,
  };
}

console.log(JSON.stringify({ ok: Boolean(slots.active), runRoot, pointerRevision: pointers.revision, slots }, null, 2));
if (!slots.active) process.exitCode = 1;
