import path from "node:path";
import {
  projectRoot,
  publicIdentity,
  readJson,
  readSlotReceipt,
  runContainerRoot,
  stageProgramTree,
  verifyProgramSlot,
} from "./runcontainer-lib.mjs";

const sourceRoot = projectRoot();
const runRoot = runContainerRoot();
const packageJson = await readJson(path.join(sourceRoot, "SYSTEM", "backend", "package.json"));
let receipt = await readSlotReceipt("active", { runRoot });

if (receipt) {
  await verifyProgramSlot("active", { runRoot });
  console.log("Aktiver Bonni-Run-Slot ist bereits vollständig und geprüft.");
} else {
  const staged = await stageProgramTree({
    role: "active",
    sourceRoot,
    runRoot,
    version: packageJson?.version || "unknown",
    replace: true,
    allowReplaceActive: true,
    // npm start runs only after the canonical backend dependencies exist.
    // The sealed Active generation must carry those dependencies itself;
    // Node ESM cannot resolve them from a sibling canonical SYSTEM tree.
    includeNodeModulesPaths: ["SYSTEM/backend/node_modules"],
    excludePaths: ["SYSTEM/backend/node_modules/.bin"],
  });
  receipt = staged.receipt;
  console.log("Aktiver Bonni-Run-Slot wurde als getrennte Programmkopie vorbereitet.");
}

console.log(`RUN: ${runRoot}`);
console.log(JSON.stringify(publicIdentity(receipt), null, 2));
