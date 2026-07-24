import path from 'node:path';
import { createIdentity, listFeatureModules, publicIdentity, readJson, slotPath, writeJson, writeRunContainerFile } from './runcontainer-lib.mjs';

const existing = await readJson(path.join(slotPath('candidate'), 'runtime-identity.json'));
const candidate = await createIdentity(existing);
await writeJson(path.join(slotPath('candidate'), 'runtime-identity.json'), candidate);
const modules = await listFeatureModules();
await writeJson(path.join(slotPath('candidate'), 'installed-feature-modules.json'), modules);
await writeRunContainerFile('candidate', candidate, modules);
await writeJson(path.join(slotPath('candidate'), 'build-info.json'), {
  source: 'vscode-local-runcontainer',
  reason: process.argv.slice(2).join(' ') || 'manual',
  createdAt: new Date().toISOString(),
});
console.log('Candidate-RunContainer wurde gebaut.');
console.log(JSON.stringify(publicIdentity(candidate), null, 2));
