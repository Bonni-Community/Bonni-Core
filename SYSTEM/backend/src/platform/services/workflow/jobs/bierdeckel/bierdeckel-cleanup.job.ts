import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "bierdeckel-cleanup";

export async function runBierdeckelCleanupJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");
    // Platzhalter für spätere Aufräumarbeiten, z. B. alte Locks, temporäre Daten.
    jobInfo(JOB_NAME, "finished", { cleaned: 0 });
    return { cleaned: 0 };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
