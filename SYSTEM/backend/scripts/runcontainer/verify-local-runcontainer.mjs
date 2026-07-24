import path from 'node:path';
import { ensureRunContainer, publicIdentity, readJson, runContainerRoot, slotPath } from './runcontainer-lib.mjs';

const active = await ensureRunContainer();
const current = await readJson(path.join(runContainerRoot(), 'current.json'));
const activePublic = publicIdentity(active);
const ok = Boolean(current) && current.createdAt === activePublic.createdAt && current.userCount === activePublic.userCount;

console.log(JSON.stringify({
  ok,
  visibleName: 'System-Abgleich',
  active: activePublic,
  current,
  activePath: slotPath('active'),
}, null, 2));

if (!ok) process.exit(1);
