import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(file, value, mode) {
  await ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    await directory.sync();
    await directory.close();
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeTextAtomic(file, value, mode = 0o600) {
  await writeAtomic(file, value, mode);
}

export function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveExistingFileInside(parent, relative) {
  const parentReal = await fs.realpath(parent);
  const candidate = path.resolve(parentReal, relative);
  if (!isInside(candidate, parentReal)) throw new Error("Pfad verlässt den erlaubten Speicherbereich.");
  const real = await fs.realpath(candidate);
  if (!isInside(real, parentReal)) throw new Error("Datei verweist aus dem erlaubten Speicherbereich.");
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("Erwartete Datei fehlt.");
  return { path: real, stat };
}

export async function listRegularFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolischer Link ist nicht erlaubt: ${file}`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Spezialdatei ist nicht erlaubt: ${file}`);
  }
  return files;
}
