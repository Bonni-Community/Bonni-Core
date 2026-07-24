import { ensureRunContainer, publicIdentity, runContainerRoot } from './runcontainer-lib.mjs';

const identity = await ensureRunContainer();
console.log('Lokaler RunContainer ist vorbereitet.');
console.log(`Pfad: ${runContainerRoot()}`);
console.log(JSON.stringify(publicIdentity(identity), null, 2));
