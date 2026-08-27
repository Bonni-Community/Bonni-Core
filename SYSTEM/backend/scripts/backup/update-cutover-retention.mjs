#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} fehlt.`);
  return value;
}

function safeRoot(name, expected) {
  const resolved = path.resolve(required(name));
  if (resolved !== expected) throw new Error(`${name} entspricht nicht dem festen Retention-Mount.`);
  return resolved;
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeExact(target, base) {
  if (!inside(base, target)) throw new Error("Retention-Ziel verlässt die feste Basis.");
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Retention-Ziel darf kein symbolischer Link sein.");
    await fs.rm(target, { recursive: stat.isDirectory(), force: false });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const snapshotId = required("BONNI_UPDATE_SNAPSHOT_ID");
if (!IDENTIFIER.test(snapshotId)) throw new Error("BONNI_UPDATE_SNAPSHOT_ID ist ungültig.");
const snapshotRoot = safeRoot("BONNI_UPDATE_ROLLBACK_SNAPSHOT_ROOT", "/var/lib/bonni-rollback-snapshots");
const resultRoot = safeRoot("BONNI_UPDATE_ROLLBACK_RESULT_ROOT", "/var/lib/bonni-rollback-results");

const snapshotRemoved = await removeExact(path.join(snapshotRoot, `snapshot-${snapshotId}`), snapshotRoot);
const resultRemoved = await removeExact(path.join(resultRoot, `${snapshotId}.json`), resultRoot);
process.stdout.write(`${JSON.stringify({ ok: true, snapshotId, snapshotRemoved, resultRemoved })}\n`);
