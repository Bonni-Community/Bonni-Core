export function createErrorWindow(writeLog, writeError) {
    let sequence = 0, persisted = 0;
    const before = [];
    let pending = [];
    const persist = (entry) => { if (entry.sequence > persisted) {
        writeLog(entry.line + "\n");
        persisted = entry.sequence;
    } };
    return {
        record(line, error) {
            const entry = { sequence: ++sequence, line };
            if (pending.length) {
                persist(entry);
                for (const item of pending) {
                    writeError(`[NACHLAUF:${item.id}] ${line}\n`);
                    item.left--;
                }
                pending = pending.filter(item => item.left > 0);
            }
            if (error) {
                before.forEach(persist);
                persist(entry);
                writeError(error.block + "\n");
                pending.push({ id: error.id, left: 5 });
            }
            before.push(entry);
            if (before.length > 5)
                before.shift();
        },
        reset() { before.length = 0; pending = []; },
    };
}
