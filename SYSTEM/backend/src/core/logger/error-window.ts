type RecordLine = { sequence: number; line: string };
export function createErrorWindow(writeLog: (text: string) => void, writeError: (text: string) => void) {
  let sequence = 0, persisted = 0;
  const before: RecordLine[] = [];
  let pending: Array<{ id: string; left: number }> = [];
  const persist = (entry: RecordLine) => { if (entry.sequence > persisted) { writeLog(entry.line + "\n"); persisted = entry.sequence; } };
  return {
    record(line: string, error?: { id: string; block: string }) {
      const entry = { sequence: ++sequence, line };
      if (pending.length) {
        persist(entry);
        for (const item of pending) { writeError(`[NACHLAUF:${item.id}] ${line}\n`); item.left--; }
        pending = pending.filter(item => item.left > 0);
      }
      if (error) {
        before.forEach(persist); persist(entry);
        writeError(error.block + "\n");
        pending.push({ id: error.id, left: 5 });
      }
      before.push(entry); if (before.length > 5) before.shift();
    },
    reset() { before.length = 0; pending = []; },
  };
}
