import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolvePersistentStorageRoot } from "../../../scripts/storage/persistent-storage-root.mjs";

const LOCK_STALE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 2 * 60 * 1000;

export function persistentSnapshotLockPath(root = resolvePersistentStorageRoot()) {
  return path.join(root, "system", "locks", "database-storage-snapshot.lock");
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Cross-process lock shared by database+storage backups and mutations which
 * change a database reference to persistent storage. A directory is used as
 * the atomic primitive because mkdir is exclusive on Windows and POSIX.
 */
export async function acquirePersistentSnapshotLock(options: {
  root?: string;
  waitMs?: number;
  operation?: string;
} = {}) {
  const lockPath = persistentSnapshotLockPath(options.root);
  const deadline = Date.now() + Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
  const owner = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
          version: 1,
          owner,
          pid: process.pid,
          operation: options.operation || "persistent-snapshot",
          acquiredAt: new Date().toISOString(),
        })}\n`, { mode: 0o600 });
      } catch (error) {
        // mkdir made us the only possible owner; do not strand a lock if its
        // ownership record cannot be durably written.
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, 60_000);
      heartbeat.unref();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        const record = await fs.readFile(path.join(lockPath, "owner.json"), "utf8").catch(() => "");
        if (record.includes(`\"owner\":\"${owner}\"`)) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const state = await fs.stat(lockPath).catch(() => null);
      if (state && Date.now() - state.mtimeMs > LOCK_STALE_MS) {
        await fs.rename(lockPath, `${lockPath}.stale-${Date.now()}-${owner}`).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("PERSISTENT_SNAPSHOT_LOCK_TIMEOUT"), {
          code: "PERSISTENT_SNAPSHOT_LOCK_TIMEOUT",
          statusCode: 423,
        });
      }
      await delay(50);
    }
  }
}

export async function withPersistentSnapshotLock<T>(
  operation: string,
  callback: () => Promise<T>,
  options: { root?: string; waitMs?: number } = {},
) {
  const release = await acquirePersistentSnapshotLock({ ...options, operation });
  try {
    return await callback();
  } finally {
    await release();
  }
}
