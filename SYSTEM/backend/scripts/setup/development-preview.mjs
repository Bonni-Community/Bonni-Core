import { createHash } from "node:crypto";

export const DEVELOPMENT_FILE_PREVIEW_SCHEMA = "bonni.development-file-preview/v1";
const keyOf = (value) => value.normalize("NFC").toLowerCase();
export function stablePreviewJson(value) {
  if (Array.isArray(value)) return `[${value.map(stablePreviewJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stablePreviewJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const previewDigest = (value) => createHash("sha256").update(stablePreviewJson(value)).digest("hex");

// Layers are in the order selected by the user. Null hashes represent removals.
// Keep every writer so even a change later reverted to the base is visible.
export function createFilePreview({ baseFiles, layers, binding }) {
  const baseline = new Map(baseFiles.map((file) => [keyOf(file.path), file]));
  const history = new Map();
  for (const layer of layers) {
    for (const file of layer.files) {
      const key = keyOf(file.path);
      const row = history.get(key) || { path: baseline.get(key)?.path || file.path, previousSha256: baseline.get(key)?.sha256 || null, writers: [] };
      row.writers.push({ source: layer.name, packageSha256: layer.packageSha256, sha256: file.sha256 });
      history.set(key, row);
    }
  }
  const files = [...history.values()].map((row) => {
    const last = row.writers.at(-1);
    const action = last.sha256 === row.previousSha256 ? "unchanged" : last.sha256 === null ? "removed" : row.previousSha256 === null ? "added" : "replaced";
    return { ...row, action, nextSha256: last.sha256, winner: last.source,
      conflict: new Set(row.writers.map((writer) => writer.sha256)).size > 1 };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const core = { schema: DEVELOPMENT_FILE_PREVIEW_SCHEMA, binding, files,
    counts: Object.fromEntries(["added", "replaced", "removed", "unchanged", "conflicts"].map((name) => [name,
      files.filter((row) => name === "conflicts" ? row.conflict : row.action === name).length])) };
  return { ...core, previewSha256: previewDigest(core) };
}

export function changedTreeFiles(before, after) {
  const old = new Map(before.map((file) => [keyOf(file.path), file]));
  const next = new Map(after.map((file) => [keyOf(file.path), file]));
  const changes = [];
  for (const [key, file] of next) if (old.get(key)?.sha256 !== file.sha256) changes.push(file);
  for (const [key, file] of old) if (!next.has(key)) changes.push({ path: file.path, sha256: null });
  return changes;
}
