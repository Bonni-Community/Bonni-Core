import { prisma } from "../../../../../core/core.js";
import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";
import { monthsAgo } from "../helpers/job-time.helper.js";

const JOB_NAME = "len-overdue";
const db = prisma as typeof prisma & Record<string, any>;

export async function runLenOverdueJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");

    if (!db.lenLoan) {
      jobWarn(JOB_NAME, "skipped because prisma model lenLoan does not exist yet");
      return { updated: 0, skipped: true };
    }

    const result = await db.lenLoan.updateMany({
      where: {
        status: { in: ["BORROWED", "DUE"] },
        borrowedAt: { lte: monthsAgo(3) }
      },
      data: {
        status: "OVERDUE",
        overdueAt: new Date()
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
