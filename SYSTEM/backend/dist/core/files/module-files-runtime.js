import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, rename, rm, open } from 'node:fs/promises';
import { resolvePersistentStorageRoot } from '../../../scripts/storage/persistent-storage-root.mjs';
import { acquirePersistentSnapshotLock } from '../storage/persistent-snapshot-lock.js';
const queues = new Map();
const LIMIT = 32 * 1024 * 1024, BATCH_LIMIT = 512 * 1024 * 1024;
const fail = (code) => Object.assign(new Error(code), { statusCode: 409 });
function relative(name) { if (typeof name !== 'string' || name.length > 220 || !name || name.startsWith('.') || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')))
    throw fail('MODULE_FILE_PATH_INVALID'); return name; }
async function noLinks(target) { const parsed = path.parse(target); let cursor = parsed.root; for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
        if ((await lstat(cursor)).isSymbolicLink())
            throw fail('MODULE_FILE_SYMLINK_DENIED');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
} }
async function durable(target, bytes) { await noLinks(target); await mkdir(path.dirname(target), { recursive: true }); const temp = target + '.tmp-' + randomUUID(); const h = await open(temp, 'wx', 0o600); try {
    await h.writeFile(bytes);
    await h.sync();
}
finally {
    await h.close();
} await rename(temp, target); let dir = path.dirname(target); for (;;) {
    await syncDir(dir);
    const parent = path.dirname(dir);
    if (parent === dir)
        break;
    dir = parent;
} }
async function syncDir(dir) { try {
    const h = await open(dir, 'r');
    try {
        await h.sync();
    }
    finally {
        await h.close();
    }
}
catch (e) {
    if (process.platform !== 'win32')
        throw e;
} }
/** Generic module-owned bytes only. The module, not Core, defines file semantics. */
export function createModuleFilesRuntime(moduleKey, rootOverride) {
    if (!/^[a-z][a-z0-9.-]{2,100}$/.test(moduleKey))
        throw fail('MODULE_FILE_OWNER_INVALID');
    const root = path.resolve(rootOverride ?? path.join(resolvePersistentStorageRoot(), 'modules', moduleKey, 'content'));
    async function recover() {
        await noLinks(root);
        await mkdir(root, { recursive: true });
        let journal;
        try {
            journal = JSON.parse(await readFile(path.join(root, '.commit.json'), 'utf8'));
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return;
            throw e;
        }
        if (!/^[a-f0-9-]{36}$/.test(journal.id) || !Array.isArray(journal.entries) || journal.entries.length > 20000)
            throw fail('MODULE_FILE_JOURNAL_INVALID');
        const stage = path.join(root, '.stage-' + journal.id);
        for (let i = 0; i < journal.entries.length; i++) {
            const entry = journal.entries[i], target = path.join(root, relative(entry.name));
            await noLinks(target);
            if (entry.hash === null) {
                await rm(target, { force: true });
                try {
                    await syncDir(path.dirname(target));
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                continue;
            }
            if (!/^[a-f0-9]{64}$/.test(entry.hash))
                throw fail('MODULE_FILE_JOURNAL_INVALID');
            const bytes = await readFile(path.join(stage, String(i)));
            if (createHash('sha256').update(bytes).digest('hex') !== entry.hash)
                throw fail('MODULE_FILE_JOURNAL_CORRUPT');
            await durable(target, bytes);
        }
        await syncDir(root);
        await rm(path.join(root, '.commit.json'));
        await syncDir(root);
        await rm(stage, { recursive: true, force: true });
    }
    return Object.freeze({ contractVersion: 'bonni.files/v1', transaction(run) {
            const before = queues.get(root) ?? Promise.resolve();
            const pending = before.catch(() => { }).then(async () => {
                const unlock = await acquirePersistentSnapshotLock({ root: rootOverride ? path.join(rootOverride, '.snapshot') : resolvePersistentStorageRoot(), waitMs: 10000, operation: 'module-files:' + moduleKey });
                try {
                    await recover();
                    const changes = new Map();
                    let total = 0, closed = false;
                    const check = () => { if (closed)
                        throw fail('MODULE_FILE_SESSION_CLOSED'); };
                    const session = {
                        async read(name) { check(); relative(name); if (changes.has(name))
                            return changes.get(name)?.slice() ?? null; const target = path.join(root, name); await noLinks(target); try {
                            const stat = await lstat(target);
                            if (!stat.isFile() || stat.size > LIMIT)
                                throw fail('MODULE_FILE_LIMIT');
                            return new Uint8Array(await readFile(target));
                        }
                        catch (e) {
                            if (e.code === 'ENOENT')
                                return null;
                            throw e;
                        } },
                        async list(prefix = '') {
                            check();
                            if (prefix)
                                relative(prefix.replace(/\/$/, ''));
                            const found = new Set();
                            async function walk(dir) { await noLinks(dir); for (const row of await readdir(dir, { withFileTypes: true })) {
                                if (row.name.startsWith('.'))
                                    continue;
                                const full = path.join(dir, row.name), name = path.relative(root, full).split(path.sep).join('/');
                                if (row.isSymbolicLink())
                                    throw fail('MODULE_FILE_SYMLINK_DENIED');
                                if (row.isDirectory())
                                    await walk(full);
                                else if (row.isFile())
                                    found.add(name);
                                if (found.size > 50000)
                                    throw fail('MODULE_FILE_COUNT_LIMIT');
                            } }
                            await walk(root);
                            for (const [name, data] of changes)
                                data === null ? found.delete(name) : found.add(name);
                            return [...found].filter(n => n.startsWith(prefix)).sort();
                        },
                        async write(name, bytes) { check(); relative(name); if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT)
                            throw fail('MODULE_FILE_LIMIT'); total += bytes.length - (changes.get(name)?.length ?? 0); if (total > BATCH_LIMIT || changes.size >= 20000)
                            throw fail('MODULE_FILE_BATCH_LIMIT'); changes.set(name, bytes.slice()); },
                        async remove(name) { check(); relative(name); if (!changes.has(name) && changes.size >= 20000)
                            throw fail('MODULE_FILE_BATCH_LIMIT'); total -= changes.get(name)?.length ?? 0; changes.set(name, null); }
                    };
                    let result;
                    try {
                        result = await run(session);
                    }
                    catch (e) {
                        closed = true;
                        throw e;
                    }
                    closed = true;
                    if (!changes.size)
                        return result;
                    const id = randomUUID(), stage = path.join(root, '.stage-' + id);
                    await mkdir(stage, { mode: 0o700 });
                    const entries = [];
                    let journalWritten = false;
                    try {
                        let i = 0;
                        for (const [name, bytes] of changes) {
                            entries.push({ name, hash: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') });
                            if (bytes)
                                await durable(path.join(stage, String(i)), bytes);
                            i++;
                        }
                        await syncDir(stage);
                        journalWritten = true;
                        await durable(path.join(root, '.commit.json'), Buffer.from(JSON.stringify({ id, entries })));
                        journalWritten = true;
                        await syncDir(root);
                    }
                    catch (e) {
                        if (!journalWritten)
                            await rm(stage, { recursive: true, force: true });
                        throw e;
                    }
                    // Once the journal is durable, startup and subsequent reads finish any interrupted commit.
                    await recover();
                    return result;
                }
                finally {
                    await unlock();
                }
            });
            queues.set(root, pending);
            void pending.finally(() => { if (queues.get(root) === pending)
                queues.delete(root); }).catch(() => { });
            return pending;
        } });
}
