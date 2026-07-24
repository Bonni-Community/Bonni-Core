const activeJobLocks = new Set<string>();

export async function withJobLock<T>(jobName: string, run: () => Promise<T> | T): Promise<{ skipped: boolean; value?: T }> {
  if (activeJobLocks.has(jobName)) {
    return { skipped: true };
  }

  activeJobLocks.add(jobName);
  try {
    const value = await run();
    return { skipped: false, value };
  } finally {
    activeJobLocks.delete(jobName);
  }
}
