import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "accounting-settlement";

export async function runAccountingSettlementJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");
    // Platzhalter für spätere automatische Verrechnung offener Buchungen.
    jobInfo(JOB_NAME, "finished", { settled: 0 });
    return { settled: 0 };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
