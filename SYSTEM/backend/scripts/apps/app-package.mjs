import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, verify, createPublicKey} from 'node:crypto';

export const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fail(code) { throw Object.assign(new Error(code), {code}); }
export function versionParts(value) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([a-z]))?(?:-dev\.([1-9]\d*))?$/i.exec(value || '');
  if (!m || [...m.slice(1,4),m[5]||'0'].some(x=>!Number.isSafeInteger(Number(x)))) fail('APP_VERSION_INVALID');
  return [...m.slice(1,4).map(Number),m[4]?.toLowerCase().charCodeAt(0)||0,m[4]?Number(m[5]||0):(m[5]?-1:0),m[4]?0:Number(m[5]||0)];
}
export function compareVersions(a,b) {
  const aa=versionParts(a),bb=versionParts(b);
  for(let i=0;i<aa.length;i++) if(aa[i]!==bb[i])return aa[i]>bb[i]?1:-1;
  return 0;
}
export async function plainDirectory(root) {
  const absolute=path.resolve(root);let cursor=path.parse(absolute).root;
  for(const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part); const s=await fs.lstat(cursor);
    if(!s.isDirectory()||s.isSymbolicLink())fail('APP_DIRECTORY_UNSAFE');
  }
  return absolute;
}
export async function readFile(file,limit=8*1024*1024) {
  const {constants}=await import('node:fs');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const a=await handle.stat(),named=await fs.lstat(file);
    if(!a.isFile()||named.isSymbolicLink()||a.nlink!==1||a.size>limit||a.ino!==named.ino||a.dev!==named.dev)fail('APP_FILE_UNSAFE');
    const bytes=await handle.readFile();const b=await handle.stat();
    if(bytes.length>limit||b.size!==a.size||b.mtimeMs!==a.mtimeMs||b.ctimeMs!==a.ctimeMs)fail('APP_FILE_CHANGED');
    return bytes;
  } finally {await handle.close();}
}
export async function inventory(root) {
  await plainDirectory(root);const files=[];let total=0;
  async function walk(dir,relative='') {
    for(const name of await fs.readdir(dir)) {
      if(!name||name!==name.normalize('NFC')||/[\\<>:"|?*\x00-\x1f\x7f]/.test(name)||/[. ]$/.test(name))fail('APP_PATH_INVALID');
      const file=path.join(dir,name),rel=relative+name,s=await fs.lstat(file);
      if(s.isSymbolicLink())fail('APP_FILE_UNSAFE');
      if(s.isDirectory())await walk(file,rel+'/');
      else {
        if(!s.isFile()||s.nlink!==1||files.length>=10000||(total+=s.size)>1024*1024*1024)fail('APP_TREE_LIMIT');
        const bytes=await readFile(file,512*1024*1024);files.push({path:rel,sizeBytes:bytes.length,sha256:sha256(bytes)});
      }
    }
  }
  await walk(root);files.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  return {files,treeSha256:sha256(canonical(files))};
}
export async function loadAppTrust(file) {
  const raw=JSON.parse(await readFile(file));
  if(raw.schema!=='bonni.app-install-trust/v1'||!Array.isArray(raw.keys)||raw.keys.length>256)fail('APP_TRUST_INVALID');
  const keys=new Map();
  for(const entry of raw.keys) {
    if(!entry||typeof entry.keyId!=='string'||keys.has(entry.keyId)||!Array.isArray(entry.scopes)
      ||entry.scopes.some(s=>s!=='RELEASE'&&!/^APP:[A-Z][A-Z0-9._-]{1,63}$/.test(s)))fail('APP_TRUST_INVALID');
    const key=createPublicKey(entry.publicKey);
    if(key.asymmetricKeyType!=='ed25519')fail('APP_TRUST_INVALID');
    keys.set(entry.keyId,{publicKey:key,scopes:entry.scopes});
  }
  return keys;
}
export async function verifyApp({root,trustedKeys,coreVersion,lastSequence=0}) {
  const manifest=JSON.parse(await readFile(path.join(root,'APP-RELEASE.json'))),s=manifest?.signed;
  if(!s||Object.keys(manifest).sort().join(',')!=='signatures,signed'
    ||Object.keys(s).sort().join(',')!=='appId,channel,createdAt,directory,files,minimumCoreVersion,releaseNotes,releaseSequence,schema,treeSha256,version'
    ||s.schema!=='bonni.standalone-app/v1'||s.channel!==(/-dev\./i.test(s.version)?'dev':'stable')||!/^APP:[A-Z][A-Z0-9._-]{1,63}$/.test('APP:'+s.appId)
    ||['SYSTEM','WINDOWS','CONTAINER','LINUX'].includes(s.appId)||s.directory!==s.appId.toLowerCase()
    ||!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(s.directory)||s.directory.endsWith('.')
    ||!Array.isArray(s.files)||!s.files.length||s.files.length>10000||!Number.isSafeInteger(s.releaseSequence)||s.releaseSequence<1
    ||typeof s.createdAt!=='string'||!Number.isFinite(Date.parse(s.createdAt))
    ||typeof s.releaseNotes!=='string'||!s.releaseNotes.trim()||!Array.isArray(manifest.signatures)||manifest.signatures.length!==2)fail('APP_MANIFEST_INVALID');
  versionParts(s.version);versionParts(s.minimumCoreVersion);
  const remaining=new Set(['RELEASE','APP:'+s.appId]);
  for(const sig of manifest.signatures) {
    const key=trustedKeys.get(sig.keyId);
    if(!remaining.has(sig.scope)||!key?.scopes.includes(sig.scope)||!/^[A-Za-z0-9+/]{86}==$/.test(sig.signature||'')
      ||!verify(null,Buffer.from('BONNI-STANDALONE-APP/v1\n'+canonical(s)),key.publicKey,Buffer.from(sig.signature,'base64')))fail('APP_SIGNATURE_INVALID');
    remaining.delete(sig.scope);
  }
  if(s.releaseSequence<=lastSequence)fail('APP_RELEASE_REPLAY');
  if(coreVersion&&compareVersions(coreVersion,s.minimumCoreVersion)<0)fail('APP_CORE_TOO_OLD');
  const appRoot=path.join(root,'PAYLOAD','APP',s.directory),tree=await inventory(appRoot),all=await inventory(root);
  if(tree.treeSha256!==s.treeSha256||canonical(tree.files)!==canonical(s.files))fail('APP_PAYLOAD_CHANGED');
  const expected=['APP-RELEASE.json',...tree.files.map(f=>'PAYLOAD/APP/'+s.directory+'/'+f.path)].sort();
  if(canonical(all.files.map(f=>f.path).sort())!==canonical(expected))fail('APP_UNEXPECTED_FILE');
  const pkg=JSON.parse(await readFile(path.join(appRoot,'package.json')));
  if(pkg.version!==s.version)fail('APP_VERSION_MISMATCH');
  return {manifest:s,appRoot,packageManifest:manifest,manifestSha256:sha256(canonical(manifest))};
}
