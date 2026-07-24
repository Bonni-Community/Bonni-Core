import { prisma } from "../../../../../core/core.js";
import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";
import { daysAgo } from "../helpers/job-time.helper.js";

const JOB_NAME = "len-due";
const db = prisma as typeof prisma & Record<string, any>;

export async function runLenDueJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");

    if (!db.lenLoan) {
      jobWarn(JOB_NAME, "skipped because prisma model lenLoan does not exist yet");
      return { updated: 0, skipped: true };
    }

    const result = await db.lenLoan.updateMany({
      where: {
        status: "BORROWED",
        borrowedAt: { lte: daysAgo(14) }
      },
      data: {
        status: "DUE",
        dueAt: new Date()
      }
    });

    jobInfo(JOB_NAME, "finished", { updated: result.count });
    return { updated: result.count };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
