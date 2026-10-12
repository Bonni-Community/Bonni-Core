import {
  buildSlotLaunchPlan,
  cloneProgramSlot,
  projectRoot,
  publicIdentity,
  runContainerRoot,
} from "./runcontainer-lib.mjs";

const sourceRoot = projectRoot();
const runRoot = runContainerRoot();
const updateId = process.argv.find((entry) => entry.startsWith("--update-id="))?.slice("--update-id=".length) || null;
const staged = await cloneProgramSlot({
  fromRole: "active",
  toRole: "candidate",
  runRoot,
  updateId,
  replace: true,
});
const launch = await buildSlotLaunchPlan("candidate", { runRoot, installationRoot: sourceRoot });

console.log("Candidate wurde als eigenständige, geprüfte Programmkopie gebaut.");
console.log(JSON.stringify({
  identity: publicIdentity(staged.receipt),
  programRoot: launch.programRoot,
  backendRoot: launch.backendRoot,
  serverPort: launch.health.serverPort,
  localAuthPort: launch.health.localAuthPort,
  databaseIsolationRequired: launch.databaseIsolationRequired,
}, null, 2));
