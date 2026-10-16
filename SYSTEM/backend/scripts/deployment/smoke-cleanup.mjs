import fs from 'node:fs/promises';

// Runs on the CI host. All operations remain scoped to this single smoke run.
export async function cleanupSmokeProject({run,root,fsImpl=fs}) {
  if(!/^\/tmp\/bonni-deployment-ci-\d+-\d+-(amd64|arm64|armv7)$/.test(root||'')||await fsImpl.realpath(root)!==root)throw Error('SMOKE_CLEANUP_SCOPE_INVALID');
  const failures=[];
  let stopped=false,emptied=false,removed=false;
  try {run(['stop','--timeout','600']);stopped=true;}catch(error){failures.push(error);}
  if(stopped) {
    try {
      run(['run','--rm','--no-deps','--pull','never','-e','BONNI_DEPLOYMENT_CI=true','--entrypoint','node','bonni-core','/app/backend/scripts/deployment/ci-cleanup.mjs']);
      emptied=true;
    }catch(error){failures.push(error);}
  }
  // Always release the outer controller container, even if inner cleanup fails.
  try {run(['down','--volumes','--remove-orphans']);removed=true;}catch(error){failures.push(error);}
  if(emptied&&removed) {
    // The host created/owns this root. rmdir refuses any remaining data;
    // never recursively delete a host tree or bypass a cleanup failure.
    try {await fsImpl.rmdir(root);}catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'SMOKE_CLEANUP_FAILED');
}

export async function withSmokeCleanup({test,cleanup,onSecondaryError=error=>console.error('Zusätzlicher Fehler beim Aufräumen des Container-Tests:',error)}) {
  let primary;
  try {await test();}catch(error){primary=error;}
  try {await cleanup();}catch(error){
    if(primary)onSecondaryError(error);else throw error;
  }
  if(primary)throw primary;
}
