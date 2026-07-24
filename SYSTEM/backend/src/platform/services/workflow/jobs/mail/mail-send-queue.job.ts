import { processMailQueue } from "../../../mail/queue/mail-queue.service.js";

export async function runMailSendQueueJob() {
  await processMailQueue();
}
