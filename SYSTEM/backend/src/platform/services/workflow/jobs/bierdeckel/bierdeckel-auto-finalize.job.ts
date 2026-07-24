import { withJobLock } from "../helpers/job-lock.helper.js";
import { jobInfo, jobWarn } from "../helpers/job-logger.helper.js";

const JOB_NAME = "bierdeckel-auto-finalize";

/**
 * feature-modules ist ein reiner Datenträger.
 * Deshalb darf dieser System-Job nicht direkt StüberlApp-Code aus feature-modules importieren.
 * Die echte Bierdeckel-Auto-Finalisierung wird erst wieder aktiviert, wenn der Fachmodul-
 * Installer die StüberlApp-Runtime sauber in den System-Runtime-Bereich übernommen hat.
 */
export async function runBierdeckelAutoFinalizeJob() {
  const result = await withJobLock(JOB_NAME, async () => {
    jobInfo(JOB_NAME, "skipped because stueberlapp runtime is not prepared in System/backend yet");
    return [];
  });

  if (result === null) {
    jobWarn(JOB_NAME, "skipped because another process holds the lock");
  }

  return result;
}
