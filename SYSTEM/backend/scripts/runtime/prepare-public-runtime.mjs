// Runs from the trusted, published Core image during a fresh installation.
// No developer tools or Windows installation are needed on the Docker host.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [projectRoot,version,image]=process.argv.slice(2);
if(!projectRoot||!path.isAbsolute(projectRoot)||!/^\d+\.\d+\.\d+(?:[+-][a-z])?$/.test(version||'')
 ||!/^sha256:[a-f0-9]{64}$/.test(image||''))throw Error('RUNTIME_INITIAL_INPUT_INVALID');
const backend=path.join(projectRoot,'SYSTEM','backend'),env=path.join(backend,'.env');
const arch={x64:'AMD64',arm64:'ARM64',arm:'ARMv7'}[process.arch];
if(!arch||process.platform!=='linux')throw Error('RUNTIME_PLATFORM_UNSUPPORTED');
const state=await fs.lstat(env).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
if(state){if(!state.isFile()||state.isSymbolicLink())throw Error('RUNTIME_ENV_UNSAFE');process.exit(0);}
const keys=JSON.parse(await fs.readFile('/app/APP-INSTALL-TRUST.json','utf8'));
if(keys.schema!=='bonni.app-install-trust/v1'||!Array.isArray(keys.keys))throw Error('RUNTIME_PUBLIC_TRUST_MISSING');
const allowed=keys.keys.filter(k=>k.scopes?.includes('RELEASE'));
if(!allowed.length)throw Error('RUNTIME_PUBLIC_TRUST_MISSING');
const trust=path.join(projectRoot,'runtime','secrets','update','trusted-keys');
await fs.mkdir(trust,{recursive:true,mode:0o700});
for(const key of allowed){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(key.keyId)||crypto.createPublicKey(key.publicKey).asymmetricKeyType!=='ed25519')throw Error('RUNTIME_PUBLIC_TRUST_INVALID');
 const file=path.join(trust,key.keyId+'.pem');
 const existing=await fs.readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
 if(existing&&existing!==key.publicKey)throw Error('RUNTIME_PUBLIC_TRUST_CONFLICT');
 if(!existing)await fs.writeFile(file,key.publicKey,{flag:'wx',mode:0o644});
}
const timezone=process.env.TZ;
if(!timezone||! /^[A-Za-z0-9_+./-]+$/.test(timezone))throw Error('SERVER_TIMEZONE_REQUIRED');
new Intl.DateTimeFormat('en',{timeZone:timezone}).format();
const admin='A7!'+crypto.randomBytes(24).toString('base64url');
// Random project name prevents volume/tag collisions between independent tests.
const project='bonni-'+crypto.randomBytes(6).toString('hex');
const text=`TZ=${timezone}\nCOMPOSE_PROJECT_NAME=${project}\nSYSTEM_VERSION=${version}\nBONNI_INITIAL_IMAGE=${image}\nBONNI_UPDATE_RUNNER_IMAGE=${project}-update-runner:runtime-v0.4.0\nBONNI_RUNTIME_PROXY_IMAGE=${project}-runtime-proxy:runtime-v1\nPOSTGRES_USER=postgres\nPOSTGRES_DB=bonni_core\nBONNI_BOOTSTRAP_ADMIN_PASSWORD=${admin}\nBONNI_BOOTSTRAP_FIRST_INSTALL_ONLY=true\nBONNI_UPDATE_MANIFEST_URL=https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest-${arch}.json\n`;
await fs.writeFile(env,text,{flag:'wx',mode:0o600});
console.log('Runtime angelegt. Erstes Admin-Kennwort steht in SYSTEM/backend/.env (BONNI_BOOTSTRAP_ADMIN_PASSWORD).');
