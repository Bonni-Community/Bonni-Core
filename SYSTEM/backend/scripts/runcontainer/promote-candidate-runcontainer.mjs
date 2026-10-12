import {
  finalizeProgramSlotPromotion,
  promoteCandidateProgramSlot,
  publicIdentity,
  runContainerRoot,
} from "./runcontainer-lib.mjs";

const runRoot = runContainerRoot();
const promoted = await promoteCandidateProgramSlot({ runRoot });
const transaction = await finalizeProgramSlotPromotion({
  runRoot,
  transactionId: promoted.transaction.transactionId,
});

console.log("Candidate wurde atomar aktiviert; der bisherige Active-Slot ist jetzt Previous.");
console.log(JSON.stringify({
  active: publicIdentity(promoted.active),
  previous: publicIdentity(promoted.previous),
  transaction,
}, null, 2));
