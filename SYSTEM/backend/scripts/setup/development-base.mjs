// Resolve the precise immutable Labor basis. A Core version can have several
// local snapshots, while an installed/signed version folder remains unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectDevelopmentTree} from '../development/release-assembly.mjs';
function fail(code) { throw Object.assign(new Error(code), {code}); }
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
async function plain(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DEVELOPMENT_BASE_PATH_UNSAFE');
}
async function json(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail('DEVELOPMENT_BASE_RECEIPT_INVALID');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function resolveDevelopmentBase({productRoot, baseVersion, baseRoot, expectedTreeSha256, withInventory = false, onProgress} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(baseVersion || '')) fail('DEVELOPMENT_BASE_VERSION_INVALID');
  const development = path.join(path.resolve(productRoot), 'RUN_DEV');
  const bases = path.join(development, 'BASES');
  for (const directory of [development, bases]) await plain(directory);
  const verify = async root => {
    const envelope = path.dirname(root), name = path.basename(envelope);
    const local = name.startsWith(`${baseVersion}--`) && /^[a-f0-9]{16}$/.test(name.slice(baseVersion.length + 2));
    if (path.dirname(envelope) !== bases || path.basename(root) !== 'SYSTEM' || (name !== baseVersion && !local)) {
      fail('DEVELOPMENT_TEST_SET_BASE_ROOT_OUTSIDE_VERSIONED_BASE');
    }
    await plain(envelope); await plain(root);
    const inventory = await collectDevelopmentTree(root, {onProgress});
    if (expectedTreeSha256 && inventory.treeSha256 !== expectedTreeSha256) fail('DEVELOPMENT_TEST_SET_BASE_TREE_CHANGED');
    if (local) {
      const system = {fileCount:inventory.files.length, totalBytes:inventory.files.reduce((n, f) => n + f.sizeBytes, 0), treeSha256:inventory.treeSha256};
      const identity = hash({schema:'bonni.active-installed-base/v1', baseVersion, system});
      const base = await json(path.join(envelope, 'BASE.json'));
      const active = await json(path.join(envelope, 'ACTIVE-BASE.json'));
      if (name !== `${baseVersion}--${identity.slice(0, 16)}` ||
          stable(base) !== stable({schema:'bonni.development-base/v1', version:baseVersion, system}) ||
          stable(active) !== stable({schema:'bonni.active-installed-base/v1', kind:'active-installed-base', baseVersion,
            source:'installed-system', sanitized:true, identitySha256:identity, system})) fail('DEVELOPMENT_BASE_RECEIPT_INVALID');
    }
    return withInventory ? {root, inventory} : root;
  };
  if (baseRoot !== undefined) return verify(path.resolve(baseRoot));
  const versionRoot = path.join(bases, baseVersion, 'SYSTEM');
  if (!expectedTreeSha256) return verify(versionRoot);
  // A test receipt names both version and tree. Find that exact retained basis;
  // never substitute the newest snapshot merely because its version matches.
  const names = await fs.readdir(bases);
  const candidates = names.filter(name => name === baseVersion ||
    (name.startsWith(`${baseVersion}--`) && /^[a-f0-9]{16}$/.test(name.slice(baseVersion.length + 2))));
  for (const name of candidates.sort()) {
    try { return await verify(path.join(bases, name, 'SYSTEM')); }
    catch (error) {
      if (error.code !== 'DEVELOPMENT_TEST_SET_BASE_TREE_CHANGED') throw error;
    }
  }
  fail('DEVELOPMENT_TEST_SET_BASE_TREE_CHANGED');
}
