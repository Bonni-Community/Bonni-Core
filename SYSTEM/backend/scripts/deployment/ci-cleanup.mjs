// Only the publisher's disposable smoke root is eligible. Never installed in
// the persistent server runtime and never used for production recovery.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export async function cleanupCiDeployment({environment=process.env,fsImpl=fs,docker=(args,options)=>execFileSync('docker',args,options)}={}) {
  const root=environment.BONNI_HOST_PROJECT_ROOT;
  if(environment.BONNI_DEPLOYMENT_CI!=='true'||!/^\/tmp\/bonni-deployment-ci-\d+-\d+-(amd64|arm64|armv7)$/.test(root||'')||await fsImpl.realpath(root)!==root)throw Error('CI_CLEANUP_SCOPE_INVALID');
  const state=JSON.parse(await fsImpl.readFile(root+'/.bonni-deployment.json','utf8'));
  if(state.root!==root||!/^bonni-[a-f0-9]{12}$/.test(state.project))throw Error('CI_CLEANUP_IDENTITY_INVALID');
  const env={...environment,COMPOSE_PROJECT_NAME:state.project,BONNI_HOST_RUNTIME_ROOT:root+'/runtime',BONNI_HOST_RUN_SYSTEM_ROOT:root+'/run_system',BONNI_RUNTIME_ENV_FILE:root+'/SYSTEM/backend/.env',BONNI_HOST_ACTIVE_RELEASE_ROOT:root+'/runtime/update-runner/active',BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR:root+'/runtime/secrets/update/trusted-keys'};
  // Runtime data was created by this job, verified by both a unique CI path and
  // the installed random project identity. No wildcard Docker cleanup.
  docker(['compose','--env-file',env.BONNI_RUNTIME_ENV_FILE,'--env-file',env.BONNI_HOST_ACTIVE_RELEASE_ROOT+'/active-release.env','-p',state.project,'-f',root+'/SYSTEM/backend/docker-compose.runtime.yml','--profile','update','down','--volumes','--remove-orphans'],{env,stdio:'inherit'});
  for(const slot of ['active','emergency','rollback','candidate']){
    const tag=state.project+'-system:'+slot;
    try{docker(['image','inspect',tag],{stdio:'ignore'});}catch{continue;}
    docker(['image','rm',tag],{stdio:'inherit'});
  }
  // root is this container's bind mount. Removing the mount itself raises
  // EBUSY even after all child runtime containers have stopped. Empty it here;
  // smoke.mjs removes the empty directory on the host after Compose down.
  const marker='.bonni-deployment.json';
  for(const name of await fsImpl.readdir(root)) {
    if(name!==marker)await fsImpl.rm(root+'/'+name,{recursive:true,force:true});
  }
  // Keep identity available if an earlier child could not be removed.
  await fsImpl.unlink(root+'/'+marker);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await cleanupCiDeployment();
