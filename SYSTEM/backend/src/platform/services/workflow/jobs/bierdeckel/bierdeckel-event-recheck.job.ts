import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "bierdeckel-event-recheck";

export async function runBierdeckelEventRecheckJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "started");

    // Platzhalter: Hier werden später Bierdeckel innerhalb der 14-Tage-Prüfzeit
    // gegen nachgetragene Events am Konsumtag neu bewertet.
    const rechecked = 0;

    jobInfo(JOB_NAME, "finished", { rechecked });
    return { rechecked };
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
