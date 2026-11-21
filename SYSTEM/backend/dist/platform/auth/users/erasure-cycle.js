const unique = (values) => [...new Set(values)].sort();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validReceipt(value, id, field) {
    const v = value;
    if (!v || v.requestId !== id || v[field] !== true)
        fail("ERASURE_PARTICIPANT_RECEIPT_INVALID");
}
function safeFailure(error) {
    const code = error?.code;
    return typeof code === "string" && /^ERASURE_[A-Z_]{1,100}$/.test(code) ? code : "ERASURE_PARTICIPANT_UNAVAILABLE";
}
export function createErasureCycle(ports) {
    const p = ports;
    async function prepare(row) {
        if (row.state === "COMPLETED")
            return;
        await p.verifyApproval(row);
        // Persist intent BEFORE cross-database side effects. Recovery repeats these
        // idempotent actions if a process dies between a commit and its receipt.
        const current = unique(await p.participants(row));
        if (!current.includes("core"))
            fail("ERASURE_CORE_PARTICIPANT_REQUIRED");
        row.participants = unique([...row.participants, ...current]);
        await p.save(row);
        await p.deactivate(row);
        if (row.state === "APPROVED_PENDING_CHECKS")
            row.state = "DEACTIVATED";
        await p.save(row);
        for (const key of row.participants) {
            const receipt = await p.freeze(key, row);
            validReceipt(receipt, row.id, "frozen");
            if (!Array.isArray(receipt.references) || receipt.references.length > 100_000 ||
                receipt.references.some(id => typeof id !== "string" || !id || id.length > 200))
                fail("ERASURE_FENCE_INVALID");
            row.references = unique([...row.references, ...receipt.references]);
            row.frozen = unique([...row.frozen, key]);
            await p.save(row);
        }
        if (row.state !== "ERASING")
            row.state = "WAITING_CYCLE";
        row.blockers = [];
        await p.save(row);
    }
    async function inspect(row) {
        const blockers = [];
        const current = await p.participants(row);
        if (current.some(key => !row.participants.includes(key)) || row.participants.some(key => !row.frozen.includes(key)))
            return ["ERASURE_PARTICIPANTS_CHANGED"];
        for (const key of row.participants) {
            if (row.erased.includes(key)) {
                validReceipt(await p.verify(key, row), row.id, "erased");
                continue;
            }
            const result = await p.inspect(key, row);
            if (result?.status !== "clear" || !Array.isArray(result.reasons) || result.reasons.length !== 0)
                blockers.push(...(Array.isArray(result?.reasons) && result.reasons.length ? result.reasons.filter(code => /^[A-Z_]{1,80}$/.test(code)).map(code => `${key}:${code}`) : [`${key}:DATA_UNAVAILABLE`]));
        }
        return blockers;
    }
    return {
        prepare,
        async run(requestId) {
            return p.exclusive(async () => {
                const rows = (await p.load()).filter(row => row.state !== "COMPLETED" && (!requestId || row.id === requestId));
                const ready = [];
                for (const row of rows) {
                    try {
                        await prepare(row);
                        const blockers = await inspect(row);
                        if (blockers.length) {
                            row.state = "BLOCKED";
                            row.blockers = blockers;
                            await p.save(row);
                        }
                        else
                            ready.push(row);
                    }
                    catch (error) {
                        row.state = "BLOCKED";
                        row.blockers = [safeFailure(error)];
                        await p.save(row);
                    }
                }
                if (!ready.length)
                    return { completed: 0, blocked: rows.length, backupId: null };
                const cycleId = p.now().toISOString();
                const backup = await p.backup("before-erasure:" + cycleId);
                if (!backup?.id || !await p.validateBackup(backup.id))
                    fail("ERASURE_VERIFIED_BACKUP_REQUIRED");
                let completed = 0;
                for (const row of ready) {
                    row.backupId = backup.id;
                    row.state = "ERASING";
                    await p.save(row);
                    try {
                        // Do not reuse the earlier zero-balance/queue result after backup.
                        if ((await inspect(row)).length)
                            fail("ERASURE_FINAL_CHECK_BLOCKED");
                        const order = [...row.participants.filter(key => key !== "core"), "core"];
                        for (const key of order) {
                            if (!row.erased.includes(key)) {
                                const proof = await p.erase(key, row);
                                validReceipt(proof, row.id, "erased");
                                validReceipt(await p.verify(key, row), row.id, "erased");
                                row.erased = unique([...row.erased, key]);
                                await p.save(row);
                            }
                        }
                        // Recheck all receipts, including a previously interrupted attempt.
                        for (const key of row.participants)
                            validReceipt(await p.verify(key, row), row.id, "erased");
                        row.state = "COMPLETED";
                        row.blockers = [];
                        row.completedAt = p.now().toISOString();
                        await p.save(row);
                        completed++;
                    }
                    catch (error) {
                        row.state = "BLOCKED";
                        row.blockers = [safeFailure(error)];
                        await p.save(row);
                    }
                }
                // A failed post-backup does not undo verified erasures. The pre-backup
                // stays protected; rotation is allowed only after a verified post-backup.
                let postBackupId = null;
                if (completed) {
                    const after = await p.backup("after-erasure:" + cycleId);
                    if (await p.validateBackup(after.id))
                        postBackupId = after.id;
                }
                return { completed, blocked: rows.length - completed, backupId: backup.id, postBackupId };
            });
        },
    };
}
