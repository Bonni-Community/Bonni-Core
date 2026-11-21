import { AsyncLocalStorage } from "node:async_hooks";
import { getServerPrismaClient, normalizePrismaConnectionString } from "../../../core/database/prisma.js";
import { getDatabaseTargetConnectionString } from "../../../core/database/database-routing.js";
import { getDataDomainConnectionString } from "../../../core/database/data-domain-routing.js";
import pg from "pg";
const scope = new AsyncLocalStorage();
export const ERASURE_BARRIER_KEY = 1_368_123_771;
const privacy = () => getServerPrismaClient("privacy");
let lockPool;
let lockUrl = "";
async function locked(shared, work) {
    const url = getDataDomainConnectionString("privacy", "normal", getDatabaseTargetConnectionString("normal"));
    if (url !== lockUrl) {
        const old = lockPool;
        lockPool = new pg.Pool({ connectionString: normalizePrismaConnectionString(url), max: 20, connectionTimeoutMillis: 10_000 });
        lockUrl = url;
        void old?.end();
    }
    const client = await lockPool.connect();
    const suffix = shared ? "_shared" : "";
    let acquired = false;
    try {
        await client.query("SET lock_timeout = '15s'");
        await client.query(`SELECT pg_advisory_lock${suffix}($1)`, [ERASURE_BARRIER_KEY]);
        acquired = true;
        return await work();
    }
    finally {
        let broken = false;
        if (acquired)
            try {
                await client.query(`SELECT pg_advisory_unlock${suffix}($1)`, [ERASURE_BARRIER_KEY]);
            }
            catch {
                broken = true;
            }
        client.release(broken);
    }
}
export function withErasureMaintenance(work) {
    return scope.run("maintenance", work);
}
export async function erasureExclusive(work) {
    if (scope.getStore() === "maintenance")
        return work();
    return locked(false, () => withErasureMaintenance(work));
}
async function frozenReferences() {
    const db = privacy();
    const [active, tombstones] = await Promise.all([
        db.privacyRequest.findMany({ where: { requestType: "SYSTEM_WIDE_USER_ERASURE_V1", status: "IN_REVIEW" }, select: { resultJson: true } }),
        db.privacySetting.findMany({ where: { key: { startsWith: "erasure:tombstone:" } }, select: { value: true } }),
    ]);
    const ids = new Set();
    for (const row of active) {
        const cycle = row.resultJson?.cycle;
        if (cycle?.subject)
            for (const values of [cycle.subject.accountIds, cycle.subject.personIds, cycle.subject.memberIds, cycle.references])
                if (Array.isArray(values))
                    for (const value of values)
                        if (typeof value === "string")
                            ids.add(value);
    }
    for (const row of tombstones)
        for (const id of row.value?.references || [])
            if (typeof id === "string")
                ids.add(id);
    return ids;
}
function intersects(value, ids, depth = 0) {
    if (depth > 60)
        throw Object.assign(new Error("ERASURE_WRITE_INPUT_TOO_DEEP"), { code: "ERASURE_WRITE_INPUT_TOO_DEEP", statusCode: 409 });
    if (typeof value === "string")
        return ids.has(value) || [...ids].some(id => id.length >= 8 && value.includes(id));
    if (Array.isArray(value))
        return value.some(item => intersects(item, ids, depth + 1));
    if (value && typeof value === "object" && !(value instanceof Date) && !ArrayBuffer.isView(value))
        return Object.values(value).some(item => intersects(item, ids, depth + 1));
    return false;
}
const blocked = () => { throw Object.assign(new Error("Für diesen Benutzer läuft eine systemweite Löschung. Neue Buchungen und Änderungen sind gesperrt."), { code: "ERASURE_SUBJECT_FROZEN", statusCode: 423 }); };
export async function withErasureWriteLock(work) {
    if (scope.getStore())
        return work();
    return locked(true, () => scope.run("write", work));
}
export async function guardModuleWrite(delegate, operation, args, work) {
    if (scope.getStore() === "maintenance")
        return work();
    return withErasureWriteLock(async () => {
        const ids = await frozenReferences();
        await assertErasureWriteAllowed(delegate, operation, args, ids);
        return work();
    });
}
export async function assertErasureWriteAllowed(delegate, operation, args, ids) {
    if (!ids.size)
        return;
    if (intersects(args, ids))
        blocked();
    // Bulk writes may omit the subject ID from their predicate. Inspect the
    // affected rows before allowing them; never infer safety from empty input.
    if (["update", "updateMany", "updateManyAndReturn", "delete", "deleteMany", "upsert"].includes(operation)) {
        const rows = await delegate.findMany({ where: args[0]?.where, take: 10_001 });
        if (rows.length > 10_000 || intersects(rows, ids))
            blocked();
    }
}
export async function assertAccountNotErasing(accountId) {
    if (scope.getStore() === "maintenance")
        return;
    if ((await frozenReferences()).has(accountId))
        blocked();
}
/** Wrap Core ports too: a module cannot bypass its database fence by asking
 * the shared profile/archive service to mutate the same subject instead. */
export function guardErasurePort(port, depth = 0) {
    return new Proxy(Object.create(null), {
        get(_target, field) {
            const value = Reflect.get(port, field, port);
            if (typeof value === "function") {
                if (typeof field !== "string" || !/^(create|save|update|replace|remove|delete|set|assign|grant|revoke|link|attach|copy|deposit|upload|change)/.test(field))
                    return value.bind(port);
                return (...args) => guardModuleWrite({}, String(field), args, () => Promise.resolve(Reflect.apply(value, port, args)));
            }
            return value && typeof value === "object" && depth < 3 ? guardErasurePort(value, depth + 1) : value;
        },
        has(_target, field) { return field in port; },
        ownKeys() { return Reflect.ownKeys(port); },
        getOwnPropertyDescriptor(_target, field) { return field in port ? { configurable: true, enumerable: true } : undefined; },
    });
}
