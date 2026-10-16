import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// Derive from the reviewed runtime topology; never maintain a second stale
// copy of the isolation, snapshot or boot-recovery definitions.
export function deploymentTemplate(source) {
  if(!source.includes('  update-runner:\n')||!source.includes('  update-snapshot-restore:\n'))throw Error('DEPLOYMENT_RUNTIME_CONTRACT_MISSING');
  let result=source.replaceAll('postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777','"${BONNI_DATABASE_IMAGE:?Festes Datenbank-Image fehlt}"');
  result=result.replaceAll('${POSTGRES_PASSWORD:?POSTGRES_PASSWORD muss gesetzt sein}@','${BONNI_DB_URL_PASSWORD:?Kodiertes Datenbankkennwort fehlt}@');
  result=result.replace(/    build:\n      context: \.\.\/\.\.\n      dockerfile: SYSTEM\/backend\/ops\/(?:runtime\/proxy|update-runner)\/Dockerfile\n/g,'    pull_policy: never\n');
  const runner=result.indexOf('  update-runner:\n');
  result=result.slice(0,runner)+result.slice(runner).replace('    # The host boot gate', '    entrypoint: ["node", "/runner/SYSTEM/backend/ops/update-runner/run.mjs"]\n    command: []\n    # The host boot gate');
  const proxy=result.indexOf('  runtime-proxy:\n');
  result=result.slice(0,proxy)+result.slice(proxy).replace('    # Never reopen', '    entrypoint: ["node", "/app/backend/scripts/deployment/proxy.mjs"]\n    command: []\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:8080/runtime-proxy/status\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n      interval: 10s\n      timeout: 3s\n      retries: 6\n    # Never reopen');
  result=result.replace('the closed runtime-proxy nginx container','the closed runtime-proxy container');
  return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const source=await fs.readFile(path.join(backend,'docker-compose.runtime.yml'),'utf8');
  await fs.writeFile(path.join(backend,'docker-compose.deployment.yml'),deploymentTemplate(source));
}
