import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "accounting-balance";

export async function runAccountingBalanceJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");
    // Platzhalter für spätere Cache-Aktualisierung von Kontosalden.
    jobInfo(JOB_NAME, "finished", { recalculated: 0 });
    return { recalculated: 0 };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
