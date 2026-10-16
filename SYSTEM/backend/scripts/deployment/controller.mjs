// The normal Compose entry point. All controller code is in the Core image;
// only Docker and the persistent data directory are required on the server.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execute=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const immutable=/^sha256:[a-f0-9]{64}$/;
export const RUNTIME_SERVICES=['db','backend-active','backend-emergency','runtime-proxy','update-runner'];

async function regularJson(file){
  const stat=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)throw Error('DEPLOYMENT_STATE_UNSAFE');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
async function writeJson(file,value){
  const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,file);
}
function safeSecret(value,min,name){
  if(typeof value!=='string'||value.length<min||value.length>512||/[\r\n'$]/.test(value)||/BITTE_|change.?me|replace|example|default|password|postgres|placeholder/i.test(value))throw Error('Bitte gültigen eigenen Wert setzen: '+name);
  return value;
}
export async function prepareDeployment({root,sourceRoot,environment=process.env,docker,trustFile="/app/APP-INSTALL-TRUST.json"}){
  if(!path.isAbsolute(root)||root===path.parse(root).root||!/^\/[A-Za-z0-9_./-]+$/.test(root)||path.resolve(root)!==root)throw Error('DEPLOYMENT_DATA_PATH_INVALID');
  if(await fs.realpath(root)!==root)throw Error('DEPLOYMENT_DATA_PATH_SYMLINK');
  const stateFile=path.join(root,'.bonni-deployment.json');
  let state=await regularJson(stateFile);
  if(state){
    if(state.schema!=='bonni.container-deployment/v1'||state.root!==root||!/^bonni-[a-f0-9]{12}$/.test(state.project)||!immutable.test(state.initialImage)||!immutable.test(state.databaseImage)||!/^[-_A-Za-z0-9]{43}$/.test(state.activationToken))throw Error('DEPLOYMENT_STATE_INVALID');
    if(state.phase==='ready')return state; // Never overwrite live config or pins.
    if(state.phase!=='initializing')throw Error('DEPLOYMENT_STATE_INVALID');
  }else{
    const files=(await fs.readdir(root)).filter(n=>n!=='.bonni-controller.lock');
    if(files.length)throw Error('DEPLOYMENT_DATA_DIRECTORY_NOT_EMPTY');
    const env=environment;
    const password=safeSecret(env.POSTGRES_PASSWORD,24,'POSTGRES_PASSWORD');
    const master=safeSecret(env.MASTER_KEY,43,'MASTER_KEY');
    const admin=safeSecret(env.BONNI_BOOTSTRAP_ADMIN_PASSWORD,16,'BONNI_BOOTSTRAP_ADMIN_PASSWORD');
    if(!/[a-z]/.test(admin)||!/[A-Z]/.test(admin)||!/[0-9]/.test(admin)||!/[!@#%^&*()_+=:;,.?/-]/.test(admin))throw Error('DEPLOYMENT_ADMIN_PASSWORD_TOO_SIMPLE');
    const platform=env.BONNI_PLATFORM;
    const architecture={'linux/amd64':'AMD64','linux/arm64':'ARM64','linux/arm/v7':'ARMv7'}[platform];
    if(!architecture)throw Error('DEPLOYMENT_PLATFORM_INVALID');
    const inspect=async reference=>{
      if(!/^[a-z0-9][a-z0-9._:/@-]{1,255}$/.test(reference||''))throw Error('DEPLOYMENT_IMAGE_REFERENCE_INVALID');
      let details;
      try{details=JSON.parse(await docker(['image','inspect',reference]));}
      catch(error){if(env.BONNI_OFFLINE==='true')throw Error('DEPLOYMENT_OFFLINE_IMAGE_MISSING');await docker(['pull','--platform',platform,reference]);details=JSON.parse(await docker(['image','inspect',reference]));}
      if(details.length!==1||!immutable.test(details[0].Id))throw Error('DEPLOYMENT_IMAGE_INVALID');
      const d=details[0],actual=d.Os+'/'+d.Architecture+(d.Architecture==='arm'?'/'+d.Variant:'');
      if(actual!==platform)throw Error('DEPLOYMENT_IMAGE_PLATFORM_MISMATCH');
      return d;
    };
    const image=await inspect(env.BONNI_INITIAL_IMAGE),database=await inspect(env.BONNI_DATABASE_IMAGE);
    const version=image.Config?.Labels?.['org.opencontainers.image.version']?.replace(/-([a-z])$/,'+$1');
    if(!/^\d+\.\d+\.\d+(?:\+[a-z])?$/.test(version||'')||image.Config.Labels['org.bonni.deployment.contract']!=='1')throw Error('DEPLOYMENT_IMAGE_CONTRACT_MISSING');
    const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if(!timeZone||/[\r\n'$]/.test(timeZone))throw Error('DEPLOYMENT_SERVER_TIMEZONE_INVALID');
    const port=String(env.BONNI_HTTP_PORT||'4000');
    if(!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('DEPLOYMENT_PORT_INVALID');
    const project='bonni-'+crypto.randomBytes(6).toString('hex');
    state={schema:'bonni.container-deployment/v1',phase:'initializing',root,project,initialImage:image.Id,databaseImage:database.Id,version,architecture,activationToken:crypto.randomBytes(32).toString('base64url'),port,timeZone};
    // Persist the initial settings atomically with the installation intent.
    // A restart can complete this same installation but cannot invent secrets.
    state.initialEnvironment={POSTGRES_PASSWORD:password,MASTER_KEY:master,BONNI_BOOTSTRAP_ADMIN_PASSWORD:admin};
    await writeJson(stateFile,state);
  }
  await fs.mkdir(path.join(root,'SYSTEM','backend'),{recursive:true,mode:0o700});
  // The source is inside the immutable image. Only program files are copied;
  // startup never overlays storage, UPDATE, extensions or an existing .env.
  await fs.cp(sourceRoot,path.join(root,'SYSTEM','backend'),{recursive:true,force:true,filter:source=>!['.env'].includes(path.basename(source))});
  const trust=JSON.parse(await fs.readFile(trustFile,'utf8'));
  const keys=trust.schema==='bonni.app-install-trust/v1'&&trust.keys?.filter(k=>k.scopes?.includes('RELEASE'));
  if(!keys?.length)throw Error('DEPLOYMENT_PUBLIC_RELEASE_TRUST_MISSING');
  const trustDir=path.join(root,'runtime','secrets','update','trusted-keys');await fs.mkdir(trustDir,{recursive:true,mode:0o700});
  for(const key of keys){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(key.keyId)||crypto.createPublicKey(key.publicKey).asymmetricKeyType!=='ed25519')throw Error('DEPLOYMENT_PUBLIC_TRUST_INVALID');
    await fs.writeFile(path.join(trustDir,key.keyId+'.pem'),key.publicKey,{mode:0o644});
  }
  const envFile=path.join(root,'SYSTEM','backend','.env');
  const envState=await fs.lstat(envFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(envState&&(envState.isSymbolicLink()||!envState.isFile()))throw Error('DEPLOYMENT_ENV_UNSAFE');
  if(!envState){
    const values={COMPOSE_PROJECT_NAME:state.project,SYSTEM_VERSION:state.version,BONNI_INITIAL_IMAGE:state.initialImage,
      BONNI_DATABASE_IMAGE:state.databaseImage,BONNI_UPDATE_RUNNER_IMAGE:state.initialImage,BONNI_RUNTIME_PROXY_IMAGE:state.initialImage,
      BACKEND_PORT:state.port,TZ:state.timeZone,POSTGRES_USER:'postgres',POSTGRES_DB:'bonni_core',...state.initialEnvironment,
      BONNI_DB_URL_PASSWORD:encodeURIComponent(state.initialEnvironment.POSTGRES_PASSWORD),BONNI_BOOTSTRAP_FIRST_INSTALL_ONLY:'true',
      BONNI_UPDATE_MANIFEST_URL:`https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest-${state.architecture}.json`};
    const temporary=envFile+'.initial';
    await fs.writeFile(temporary,Object.entries(values).map(([key,value])=>`${key}='${value}'`).join('\n')+'\n',{mode:0o600});
    await fs.rename(temporary,envFile);
  }
  state.phase='ready';delete state.initialEnvironment;await writeJson(stateFile,state);
  return state;
}
export async function deploymentHealthy(state,docker){
  const ids=(await docker(['ps','-q','--filter','label=com.docker.compose.project='+state.project])).trim().split(/\s+/).filter(Boolean);
  if(!ids.length)return false;
  const details=JSON.parse(await docker(['inspect',...ids]));
  return RUNTIME_SERVICES.every(name=>details.filter(d=>d.Config?.Labels?.['com.docker.compose.service']===name&&d.State?.Running&&d.State.Health?.Status==='healthy').length===1);
}
async function main(){
  const root=process.env.BONNI_HOST_PROJECT_ROOT;
  const docker=async args=>(await execute('docker',args,{maxBuffer:8*1024*1024,timeout:20*60_000})).stdout;
  if(process.argv.includes('--health')){
    const state=await regularJson(path.join(root,'.bonni-deployment.json'));
    process.exit(state?.phase==='ready'&&await deploymentHealthy(state,docker)?0:1);
  }
  // flock is held by the parent shell across the complete controller lifetime.
  if(process.env.BONNI_DEPLOYMENT_LOCK_HELD!=='true')throw Error('DEPLOYMENT_LOCK_REQUIRED');
  const state=await prepareDeployment({root,sourceRoot:'/opt/bonni-deployment/backend',docker});
  const backend=path.join(root,'SYSTEM','backend');
  const environment={...process.env,BONNI_HOST_PROJECT_ROOT:root,BONNI_INITIAL_IMAGE:state.initialImage,
    BONNI_MANAGED_ACTIVATION_TOKEN:state.activationToken,PORT:state.port};
  // Publisher/bootstrap-only inputs must never override the persisted .env.
  for(const key of ['POSTGRES_PASSWORD','MASTER_KEY','MODULE_PRIVATE_DATA_SECRET','BONNI_BOOTSTRAP_ADMIN_PASSWORD','BONNI_DATABASE_IMAGE','BONNI_UPDATE_RUNNER_IMAGE','BONNI_RUNTIME_PROXY_IMAGE','SYSTEM_VERSION','COMPOSE_PROJECT_NAME','SYSTEM_IMAGE','EMERGENCY_SYSTEM_IMAGE','TZ'])delete environment[key];
  const run=action=>new Promise((resolve,reject)=>{
    const child=spawn('/bin/bash',[path.join(backend,'scripts/runtime',action+'-runtime.sh'),backend],{env:environment,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('DEPLOYMENT_'+action.toUpperCase()+'_FAILED')));
  });
  let stopping=false;
  process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  await run('start');
  console.log('Bonni Core und Update-Dienst sind eingerichtet und gestartet.');
  while(!stopping)await delay(1000);
  // A requested shutdown waits for the runner's transaction boundary. A forced
  // host stop is recovered by the normal boot gate on the following startup.
  for(;;){try{await run('stop');break;}catch{console.error('Warte auf sicheren Abschluss des laufenden Updates.');await delay(2000);}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
