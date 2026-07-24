import path from 'node:path';
import { publicIdentity, readJson, runContainerRoot, slotPath, writeJson, writeRunContainerFile } from './runcontainer-lib.mjs';

const candidate = await readJson(path.join(slotPath('candidate'), 'runtime-identity.json'));
if (!candidate) {
  console.error('Kein Candidate-RunContainer vorhanden. Erst build-candidate ausführen.');
  process.exit(1);
}

const active = await readJson(path.join(slotPath('active'), 'runtime-identity.json'));
if (active) {
  await writeJson(path.join(slotPath('emergency'), 'runtime-identity.json'), active);
  const activeModules = await readJson(path.join(slotPath('active'), 'installed-feature-modules.json'));
  await writeJson(path.join(slotPath('emergency'), 'installed-feature-modules.json'), activeModules ?? []);
  await writeRunContainerFile('emergency', active, activeModules ?? []);
}

await writeJson(path.join(slotPath('active'), 'runtime-identity.json'), candidate);
const candidateModules = await readJson(path.join(slotPath('candidate'), 'installed-feature-modules.json'));
await writeJson(path.join(slotPath('active'), 'installed-feature-modules.json'), candidateModules ?? []);
await writeRunContainerFile('active', candidate, candidateModules ?? []);
await writeJson(path.join(runContainerRoot(), 'current.json'), publicIdentity({ ...candidate, slot: 'active' }));

console.log('Candidate wurde zum aktiven RunContainer gemacht.');
console.log(JSON.stringify(publicIdentity(candidate), null, 2));
