import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function projectRoot() {
  return process.env.STUEBERLAPP_ROOT
    ? path.resolve(process.env.STUEBERLAPP_ROOT)
    : path.resolve(process.cwd(), '../..');
}

export function runContainerRoot() {
  return process.env.RUNCONTAINER_ROOT
    ? path.resolve(process.env.RUNCONTAINER_ROOT)
    : path.join(projectRoot(), 'run_system', 'system');
}

export function slotPath(slot) {
  return path.join(runContainerRoot(), slot);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeStateKey(base) {
  return crypto.createHash('sha256').update(stableStringify(base)).digest('hex');
}

export function encodeRunContainerEnvelope(value) {
  const payload = Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64url');
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  return `STUEBERLAPP_RUNCONTAINER_V1\n${payload}\n${checksum}\n`;
}

export async function writeRunContainerFile(slot, identity, modules) {
  await fs.writeFile(
    path.join(slotPath(slot), 'runcontainer.stc'),
    encodeRunContainerEnvelope({
      slot,
      createdAt: new Date().toISOString(),
      identity,
      modules,
      note: 'Lokaler RunContainer. State-Key ist intern und wird nicht im Control Center angezeigt.',
    }),
    'utf8',
  );
}

export function publicIdentity(identity) {
  if (!identity) return null;
  const { stateKey, ...visible } = identity;
  return visible;
}

export async function getSystemVersion() {
  const manifest = await readJson(path.join(projectRoot(), 'System', 'system.manifest.json'));
  if (manifest?.version) return manifest.version;
  const pkg = await readJson(path.join(projectRoot(), 'System', 'backend', 'package.json'));
  return pkg?.version ?? '0.0.0-dev';
}

async function readAppManifest(directory) {
  const jsonManifest = await readJson(path.join(directory, 'manifest.json'));
  if (jsonManifest) return jsonManifest;

  try {
    const source = await fs.readFile(path.join(directory, 'manifest.ts'), 'utf8');
    const value = (key) => source.match(new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`))?.[1];
    return {
      key: value('key'),
      name: value('name'),
      version: value('version'),
      kind: value('kind'),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listFeatureModules() {
  const root = path.join(projectRoot(), 'System', 'app');
  if (!existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const modules = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readAppManifest(path.join(root, entry.name));
    if (!manifest) continue;
    modules.push({
      id: manifest.key ?? manifest.id ?? entry.name,
      name: manifest.name ?? entry.name,
      version: manifest.version ?? '0.0.0',
      type: manifest.kind ?? manifest.type ?? 'app',
      source: `System/app/${entry.name}`,
    });
  }
  return modules.sort((a, b) => a.id.localeCompare(b.id));
}

export async function createIdentity(existing = null) {
  const base = {
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    systemVersion: await getSystemVersion(),
    schemaVersion: process.env.SYSTEM_SCHEMA_VERSION ?? existing?.schemaVersion ?? 'development',
    userCount: Number(process.env.RUNCONTAINER_USER_COUNT ?? existing?.userCount ?? 0),
  };
  return { ...base, stateKey: computeStateKey(base) };
}

export async function ensureRunContainer() {
  for (const name of ['active', 'candidate', 'emergency', 'history', 'install-queue']) {
    await ensureDir(path.join(runContainerRoot(), name));
  }

  const activeFile = path.join(slotPath('active'), 'runtime-identity.json');
  let active = await readJson(activeFile);

  if (!active) {
    active = await createIdentity();
    await writeJson(activeFile, active);
    const modules = await listFeatureModules();
    await writeJson(path.join(slotPath('active'), 'installed-feature-modules.json'), modules);
    await writeRunContainerFile('active', active, modules);
    await writeJson(path.join(runContainerRoot(), 'current.json'), publicIdentity({ ...active, slot: 'active' }));
  }

  return active;
}
