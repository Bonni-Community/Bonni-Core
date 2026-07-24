import { prisma } from "../../../../../core/core.js";
import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "len-auto-charge";
const db = prisma as typeof prisma & Record<string, any>;

export async function runLenAutoChargeJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");

    if (!db.lenLoan) {
      jobWarn(JOB_NAME, "skipped because prisma model lenLoan does not exist yet");
      return { charged: 0, skipped: true };
    }

    // Platzhalter: Sobald der len-Service und accounting vollständig verbunden sind,
    // werden hier alle OVERDUE/DAMAGED/LOST Ausleihen automatisch belastet.
    const charged = 0;

    jobInfo(JOB_NAME, "finished", { charged });
    return { charged };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
