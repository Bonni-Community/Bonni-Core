import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  encryptLocalSecretVault,unlockLocalSecretVault,destroyUnlockedLocalSecretVault,
  verifyLocalSecretVaultPurpose,getLocalSecretVaultStatus,LOCAL_SECRET_VAULT_CONTENT_SCHEMA,
  withLocalSecretVaultEntry,LOCAL_SECRET_VAULT_DEVELOPER_PROFILE_ENTRY_ID as DEVELOPER_PROFILE_ENTRY_ID,
} from './local-secret-vault.mjs';
import {
  MASTER_TRUST_SCHEMA,MASTER_TRUST_RELATIVE_FILE,MASTER_STORE_RELATIVE_FILE,masterFail as fail,
  exactMasterFields as exact,masterPublicEntry,parseMasterPublicEntry,parseMasterTrust,
  assertMasterPath,readMasterFile,parseMasterJson,readDeveloperMasterTrust,
} from './developer-master-trust.mjs';

const SCHEMAS={personal:'bonni.developer-master-personal/v1',store:'bonni.developer-master/v1',recovery:'bonni.developer-master-recovery/v1'};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const serialize=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const sameIssuer=(a,b)=>a?.keyId===b?.keyId && a?.fingerprintSha256===b?.fingerprintSha256 && a?.publicKeyPem===b?.publicKeyPem;
function validatePassword(value){
  const b=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:'');
  if(b.length<8 || b.length>1024 || b.includes(0) || b.includes(10) || b.includes(13))fail('BONNI_MASTER_PASSWORD_INVALID');
}
function separatePasswords(master,recovery){
  validatePassword(master);validatePassword(recovery);
  const a=Buffer.from(master),b=Buffer.from(recovery);
  try{if(a.equals(b))fail('BONNI_MASTER_RECOVERY_PASSWORD_SEPARATE');}finally{a.fill(0);b.fill(0);}
}
function parseBundle(raw,kind){
  exact(raw,['schema','issuer','ownerVaultId','vault']);
  if(raw.schema!==SCHEMAS[kind] || !UUID.test(raw.ownerVaultId || ''))fail('BONNI_MASTER_FORMAT_INVALID');
  return {...raw,issuer:parseMasterPublicEntry(raw.issuer)};
}
function parseStoredBundle(bytes){
  const raw=parseMasterJson(bytes);
  return parseBundle(raw,raw.schema===SCHEMAS.personal?'personal':'store');
}
async function seal(privateKey,issuer,ownerVaultId,password,kind){
  validatePassword(password);
  const now=new Date().toISOString(),der=privateKey.export({type:'pkcs8',format:'der'});
  const secret=Buffer.from(JSON.stringify({purpose:kind,ownerVaultId,issuer,der:der.toString('base64')}));der.fill(0);
  const content={schema:LOCAL_SECRET_VAULT_CONTENT_SCHEMA,vaultId:crypto.randomUUID(),createdAt:now,updatedAt:now,revision:1,
    entries:[{id:'developer-master',purposes:['github-release'],createdAt:now,updatedAt:now,secret}]};
  let encrypted;
  try{
    encrypted=await encryptLocalSecretVault(content,password);
    return serialize({schema:SCHEMAS[kind],issuer,ownerVaultId,vault:JSON.parse(encrypted.toString('utf8'))});
  }finally{destroyUnlockedLocalSecretVault(content);encrypted?.fill(0);}
}
async function unseal(bytes,password,kind){
  const bundle=parseBundle(parseMasterJson(bytes),kind);
  let unlocked;
  try{
    try{unlocked=await unlockLocalSecretVault(serialize(bundle.vault),password);}catch{fail('BONNI_MASTER_UNLOCK_FAILED');}
    if(unlocked.entries.length!==1 || unlocked.entries[0].id!=='developer-master')fail('BONNI_MASTER_FORMAT_INVALID');
    const inner=parseMasterJson(unlocked.entries[0].secret);
    exact(inner,['purpose','ownerVaultId','issuer','der']);
    if(inner.purpose!==kind || inner.ownerVaultId!==bundle.ownerVaultId || !sameIssuer(inner.issuer,bundle.issuer) ||
      typeof inner.der!=='string' || inner.der.length>512 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(inner.der))fail('BONNI_MASTER_IDENTITY_MISMATCH');
    const der=Buffer.from(inner.der,'base64');let privateKey;
    try{privateKey=crypto.createPrivateKey({key:der,type:'pkcs8',format:'der'});}catch{fail('BONNI_MASTER_KEY_INVALID');}finally{der.fill(0);inner.der='';}
    if(!sameIssuer(masterPublicEntry(privateKey),bundle.issuer))fail('BONNI_MASTER_IDENTITY_MISMATCH');
    return {privateKey,issuer:bundle.issuer,ownerVaultId:bundle.ownerVaultId};
  }finally{destroyUnlockedLocalSecretVault(unlocked);}
}
async function ensureDirectory(directory){
  let cursor=path.parse(directory).root;
  for(const segment of directory.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,segment);
    try{await fs.mkdir(cursor,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    const st=await fs.lstat(cursor);if(!st.isDirectory() || st.isSymbolicLink())fail('BONNI_MASTER_PATH_UNSAFE');
  }
}
async function writeNew(file,bytes){
  await assertMasterPath(file,{parent:true});
  let handle,created=false;
  try{handle=await fs.open(file,'wx',0o600);created=true;await handle.writeFile(bytes);await handle.sync();}
  catch(e){await handle?.close();handle=null;if(created)await fs.unlink(file).catch(()=>{});if(e.code==='EEXIST')fail('BONNI_MASTER_FILE_EXISTS');throw e;}
  finally{await handle?.close();}
}
async function replacePrivate(file,bytes){
  await assertMasterPath(file,{missing:true});
  const before=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  // Recovery must also replace a truncated or otherwise unreadable ciphertext.
  // Identity is checked against the pinned public key before this function.
  if(before && (!before.isFile() || before.isSymbolicLink() || before.nlink!==1 ||
    (process.platform!=='win32' && ((before.mode&0o077)!==0 || (process.getuid && before.uid!==process.getuid())))))fail('BONNI_MASTER_FILE_UNSAFE');
  const temp=path.join(path.dirname(file),'.master-'+crypto.randomUUID()+'.tmp');
  try{await writeNew(temp,bytes);await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function withLock(productRoot,action){
  if(typeof productRoot!=='string' || !path.isAbsolute(productRoot))fail('BONNI_MASTER_PATH_INVALID');
  await assertMasterPath(productRoot);
  const directory=path.join(productRoot,'SIGNATUR','PRIVATE');await ensureDirectory(directory);
  const lock=path.join(directory,'BONNI-DEVELOPER-MASTER.lock');let handle;
  try{handle=await fs.open(lock,'wx',0o600);}catch(e){
    if(e.code!=='EEXIST')throw e;
    // A crashed helper can leave its lock. Only a dead process is reclaimed.
    const guardFile=lock+'.recovery';let guard;
    try{guard=await fs.open(guardFile,'wx',0o600);}catch{fail('BONNI_MASTER_BUSY');}
    try{
      const bytes=await readMasterFile(lock,{privateAccess:true});let stale=false;
      try{
        const old=parseMasterJson(bytes);
        if(!Number.isInteger(old.pid) || old.pid<1)fail('BONNI_MASTER_BUSY');
        try{process.kill(old.pid,0);}catch(check){if(check.code==='ESRCH')stale=true;}
      }finally{bytes.fill(0);}
      if(!stale)fail('BONNI_MASTER_BUSY');
      await fs.unlink(lock);try{handle=await fs.open(lock,'wx',0o600);}catch{fail('BONNI_MASTER_BUSY');}
    }finally{await guard.close();await fs.unlink(guardFile).catch(()=>{});}
  }
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.sync();return await action();}
  finally{await handle.close();await fs.unlink(lock).catch(()=>{});}
}
async function authenticate(productRoot,personalPassword){
  return verifyLocalSecretVaultPurpose({productRoot,password:personalPassword,purpose:'developer-area'});
}
async function backupDestination(productRoot,file){
  await assertMasterPath(file,{parent:true});
  const relative=path.relative(path.resolve(productRoot),path.resolve(file));
  if(!relative || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)))fail('BONNI_MASTER_BACKUP_SEPARATE');
  if(!file.toLowerCase().endsWith('.bonni'))fail('BONNI_MASTER_BACKUP_EXTENSION');
  if(await fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))fail('BONNI_MASTER_FILE_EXISTS');
}
export async function checkDeveloperMasterBackupDestination({productRoot,backupFile}){
  if(typeof productRoot!=='string' || !path.isAbsolute(productRoot))fail('BONNI_MASTER_PATH_INVALID');
  await backupDestination(productRoot,backupFile);
  return {valid:true};
}
async function installTrust(productRoot,issuer){
  const current=await readDeveloperMasterTrust(productRoot);
  if(current){if(!sameIssuer(current.issuer,issuer))fail('BONNI_MASTER_TRUST_CONFLICT');return;}
  await ensureDirectory(path.join(productRoot,'SYSTEM'));
  await writeNew(path.join(productRoot,MASTER_TRUST_RELATIVE_FILE),serialize({schema:MASTER_TRUST_SCHEMA,issuer}));
}
const BACKUP_RECEIPT='SIGNATUR/PRIVATE/BONNI-DEVELOPER-MASTER-BACKUP.json';
function backupReceiptPayload(value){
  return serialize({schema:value.schema,fingerprintSha256:value.fingerprintSha256,backupSha256:value.backupSha256,createdAt:value.createdAt});
}
async function recordBackup(productRoot,bytes,privateKey,issuer){
  const receipt={schema:'bonni.master-backup-receipt/v1',fingerprintSha256:issuer.fingerprintSha256,
    backupSha256:crypto.createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString()};
  receipt.signature=crypto.sign(null,backupReceiptPayload(receipt),privateKey).toString('base64url');
  await replacePrivate(path.join(productRoot,BACKUP_RECEIPT),serialize(receipt));
}
async function hasVerifiedBackupReceipt(productRoot,issuer){
  if(!issuer)return false;
  let bytes;
  try{
    bytes=await readMasterFile(path.join(productRoot,BACKUP_RECEIPT),{optional:true,privateAccess:true});
    if(!bytes)return false;
    const r=parseMasterJson(bytes);exact(r,['schema','fingerprintSha256','backupSha256','createdAt','signature']);
    if(r.schema!=='bonni.master-backup-receipt/v1' || r.fingerprintSha256!==issuer.fingerprintSha256 ||
      !/^[a-f0-9]{64}$/u.test(r.backupSha256??'') || typeof r.createdAt!=='string' ||
      !Number.isFinite(Date.parse(r.createdAt)) || typeof r.signature!=='string')return false;
    return crypto.verify(null,backupReceiptPayload(r),issuer.publicKeyPem,Buffer.from(r.signature,'base64url'));
  }catch{return false;}finally{bytes?.fill(0);}
}
export async function verifyDeveloperMasterBackup({productRoot,backupFile,recoveryPassword}){
  return withLock(productRoot,async()=>{
    const trust=await readDeveloperMasterTrust(productRoot);if(!trust)fail('BONNI_MASTER_NOT_CONFIGURED');
    const bytes=await readMasterFile(backupFile);let opened;
    try{
      opened=await unseal(bytes,recoveryPassword,'recovery');
      if(!sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_IDENTITY_MISMATCH');
      await recordBackup(productRoot,bytes,opened.privateKey,opened.issuer);
      return {verified:true,backupCreated:true,issuer:opened.issuer};
    }finally{bytes.fill(0);if(opened)opened.privateKey=null;}
  });
}
export async function getDeveloperMasterStatus({productRoot}){
  const trust=await readDeveloperMasterTrust(productRoot);
  const bytes=await readMasterFile(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),{optional:true,privateAccess:true});
  try{
    const bundle=bytes?parseStoredBundle(bytes):null;
    return {configured:Boolean(trust),hasPrivateKey:Boolean(bundle),personalBound:bundle?.schema===SCHEMAS.personal,
      backupCreated:await hasVerifiedBackupReceipt(productRoot,trust?.issuer??bundle?.issuer),
      ready:Boolean(bundle && trust && sameIssuer(bundle.issuer,trust.issuer)),issuer:trust?.issuer??bundle?.issuer??null};
  }finally{bytes?.fill(0);}
}
export async function createDeveloperMaster({productRoot,personalPassword,masterPassword,recoveryPassword,backupFile}){
  const identity=await authenticate(productRoot,personalPassword);separatePasswords(masterPassword,recoveryPassword);
  return withLock(productRoot,async()=>{
    const status=await getDeveloperMasterStatus({productRoot});
    if(status.configured || status.hasPrivateKey)fail('BONNI_MASTER_ALREADY_CONFIGURED');
    await backupDestination(productRoot,backupFile);
    const {privateKey}=crypto.generateKeyPairSync('ed25519'),issuer=masterPublicEntry(privateKey);
    let backup,store;
    try{
      backup=await seal(privateKey,issuer,identity.vaultId,recoveryPassword,'recovery');
      store=await seal(privateKey,issuer,identity.vaultId,masterPassword,'store');
      await unseal(backup,recoveryPassword,'recovery');
      // Recovery is committed first. A failed later step can be resumed by Restore.
      await writeNew(backupFile,backup);
      await writeNew(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),store);
      await installTrust(productRoot,issuer);
      // Read the committed file back and authenticate it before telling the UI
      // that the entered MasterAPP password was successfully saved.
      await withDeveloperMaster({productRoot,masterPassword},()=>true);
      await recordBackup(productRoot,backup,privateKey,issuer);
      return {initialized:true,passwordVerified:true,backupCreated:true,issuer,backupFile};
    }finally{backup?.fill(0);store?.fill(0);}
  });
}
export async function withDeveloperMaster({productRoot,masterPassword},action){
  const bytes=await readMasterFile(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),{privateAccess:true});
  let opened;
  try{
    opened=await unseal(bytes,masterPassword,'store');
    const trust=await readDeveloperMasterTrust(productRoot);
    if(!trust || !sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
    const vault=await getLocalSecretVaultStatus({productRoot});
    if(vault.vaultId!==opened.ownerVaultId)fail('BONNI_MASTER_OWNER_MISMATCH');
    return await action(opened);
  }finally{bytes.fill(0);if(opened)opened.privateKey=null;}
}
export async function backupDeveloperMaster({productRoot,personalPassword,masterPassword,recoveryPassword,backupFile}){
  await authenticate(productRoot,personalPassword);separatePasswords(masterPassword,recoveryPassword);
  return withLock(productRoot,()=>withDeveloperMaster({productRoot,masterPassword},async({privateKey,issuer,ownerVaultId})=>{
    await backupDestination(productRoot,backupFile);
    const backup=await seal(privateKey,issuer,ownerVaultId,recoveryPassword,'recovery');
    try{await unseal(backup,recoveryPassword,'recovery');await writeNew(backupFile,backup);await recordBackup(productRoot,backup,privateKey,issuer);return {backedUp:true,backupCreated:true,issuer,backupFile};}
    finally{backup.fill(0);}
  }));
}
export async function inspectDeveloperMasterBackup({backupFile}){
  const bytes=await readMasterFile(backupFile);
  try{return {issuer:parseBundle(parseMasterJson(bytes),'recovery').issuer};}finally{bytes.fill(0);}
}
export async function restoreDeveloperMaster({productRoot,personalPassword,recoveryPassword,masterPassword,backupFile,expectedFingerprint}){
  const identity=await authenticate(productRoot,personalPassword);separatePasswords(masterPassword,recoveryPassword);
  return withLock(productRoot,async()=>{
    const bytes=await readMasterFile(backupFile);let opened,store;
    try{
      opened=await unseal(bytes,recoveryPassword,'recovery');
      if(opened.issuer.fingerprintSha256!==expectedFingerprint)fail('BONNI_MASTER_IDENTITY_MISMATCH');
      const trust=await readDeveloperMasterTrust(productRoot);
      if(trust && !sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
      if(!trust){
        const old=await readMasterFile(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),{optional:true,privateAccess:true});
        try{if(old && !sameIssuer(parseStoredBundle(old).issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');}
        finally{old?.fill(0);}
      }
      store=await seal(opened.privateKey,opened.issuer,identity.vaultId,masterPassword,'store');
      await replacePrivate(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),store);
      await installTrust(productRoot,opened.issuer);
      await withDeveloperMaster({productRoot,masterPassword},()=>true);
      await recordBackup(productRoot,bytes,opened.privateKey,opened.issuer);
      return {restored:true,passwordVerified:true,backupCreated:true,issuer:opened.issuer};
    }finally{bytes.fill(0);store?.fill(0);if(opened)opened.privateKey=null;}
  });
}
export async function exportDeveloperMasterTrust({productRoot,destinationFile}){
  const trust=await readDeveloperMasterTrust(productRoot);if(!trust)fail('BONNI_MASTER_NOT_CONFIGURED');
  await writeNew(destinationFile,serialize(trust));return {exported:true,issuer:trust.issuer};
}
export async function inspectDeveloperMasterTrust({sourceFile}){
  const bytes=await readMasterFile(sourceFile);
  try{return parseMasterTrust(parseMasterJson(bytes));}finally{bytes.fill(0);}
}
export async function importDeveloperMasterTrust({productRoot,personalPassword,sourceFile,expectedFingerprint}){
  await authenticate(productRoot,personalPassword);
  return withLock(productRoot,async()=>{
    const trust=await inspectDeveloperMasterTrust({sourceFile});
    if(trust.issuer.fingerprintSha256!==expectedFingerprint)fail('BONNI_MASTER_IDENTITY_MISMATCH');
    const status=await getDeveloperMasterStatus({productRoot});
    if(status.issuer && !sameIssuer(status.issuer,trust.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
    await installTrust(productRoot,trust.issuer);return {imported:true,issuer:trust.issuer};
  });
}

// The developer profile contains a random secret independent of its password.
// Bind the issuer to that secret once. Changing the personal password therefore
// preserves the issuer; recreating a profile does not silently unlock it.
async function withPersonalIdentity(productRoot,personalPassword,action){
  return withLocalSecretVaultEntry({productRoot,password:personalPassword,
    entryId:DEVELOPER_PROFILE_ENTRY_ID,purpose:'developer-area',requiredPurpose:'developer-area'},
  async(secret,entry,identity)=>{
    const material=Buffer.from(crypto.hkdfSync('sha256',secret,Buffer.from(identity.vaultId),
      Buffer.from('bonni.developer-master-personal/v1'),32));
    const password=Buffer.from(material.toString('hex'));material.fill(0);
    try{return await action(password,identity);}finally{password.fill(0);}
  });
}
async function withPersonalStore(productRoot,password,vaultId,action){
  const bytes=await readMasterFile(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),{privateAccess:true});
  let opened;
  try{
    const bundle=parseStoredBundle(bytes);
    if(bundle.schema!==SCHEMAS.personal)fail('BONNI_MASTER_BINDING_REQUIRED');
    if(bundle.ownerVaultId!==vaultId)fail('BONNI_MASTER_OWNER_MISMATCH');
    opened=await unseal(bytes,password,'personal');
    const trust=await readDeveloperMasterTrust(productRoot);
    if(!trust || !sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
    return await action(opened);
  }finally{bytes.fill(0);if(opened)opened.privateKey=null;}
}
export async function withPersonalDeveloperMaster({productRoot,personalPassword},action){
  return withLock(productRoot,()=>withPersonalIdentity(productRoot,personalPassword,
    (password,identity)=>withPersonalStore(productRoot,password,identity.vaultId,action)));
}
export async function bindDeveloperMaster({productRoot,personalPassword,masterPassword}){
  return withLock(productRoot,()=>withPersonalIdentity(productRoot,personalPassword,async(password,identity)=>{
    const file=path.join(productRoot,MASTER_STORE_RELATIVE_FILE),bytes=await readMasterFile(file,{privateAccess:true});
    let opened,store;
    try{
      const bundle=parseStoredBundle(bytes);
      if(bundle.schema===SCHEMAS.personal){
        return await withPersonalStore(productRoot,password,identity.vaultId,({issuer})=>({bound:true,personalBound:true,issuer}));
      }
      if(bundle.ownerVaultId!==identity.vaultId)fail('BONNI_MASTER_OWNER_MISMATCH');
      opened=await unseal(bytes,masterPassword,'store');
      const trust=await readDeveloperMasterTrust(productRoot);
      if(!trust || !sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
      store=await seal(opened.privateKey,opened.issuer,identity.vaultId,password,'personal');
      await unseal(store,password,'personal');
      await replacePrivate(file,store);
      return await withPersonalStore(productRoot,password,identity.vaultId,({issuer})=>({bound:true,personalBound:true,issuer}));
    }finally{bytes.fill(0);store?.fill(0);if(opened)opened.privateKey=null;}
  }));
}
export async function createPersonalDeveloperMaster({productRoot,personalPassword,recoveryPassword,backupFile}){
  separatePasswords(personalPassword,recoveryPassword);
  return withLock(productRoot,()=>withPersonalIdentity(productRoot,personalPassword,async(password,identity)=>{
    const status=await getDeveloperMasterStatus({productRoot});
    if(status.configured || status.hasPrivateKey)fail('BONNI_MASTER_ALREADY_CONFIGURED');
    await backupDestination(productRoot,backupFile);
    const {privateKey}=crypto.generateKeyPairSync('ed25519'),issuer=masterPublicEntry(privateKey);
    let backup,store;
    try{
      backup=await seal(privateKey,issuer,identity.vaultId,recoveryPassword,'recovery');
      store=await seal(privateKey,issuer,identity.vaultId,password,'personal');
      await unseal(backup,recoveryPassword,'recovery');await unseal(store,password,'personal');
      await writeNew(backupFile,backup);
      await writeNew(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),store);
      await installTrust(productRoot,issuer);
      await withPersonalStore(productRoot,password,identity.vaultId,()=>true);
      await recordBackup(productRoot,backup,privateKey,issuer);
      return {initialized:true,personalBound:true,backupCreated:true,issuer,backupFile};
    }finally{backup?.fill(0);store?.fill(0);}
  }));
}
export async function backupPersonalDeveloperMaster({productRoot,personalPassword,recoveryPassword,backupFile}){
  separatePasswords(personalPassword,recoveryPassword);
  return withPersonalDeveloperMaster({productRoot,personalPassword},async({privateKey,issuer,ownerVaultId})=>{
    await backupDestination(productRoot,backupFile);
    const backup=await seal(privateKey,issuer,ownerVaultId,recoveryPassword,'recovery');
    try{
      await unseal(backup,recoveryPassword,'recovery');await writeNew(backupFile,backup);
      await recordBackup(productRoot,backup,privateKey,issuer);
      return {backedUp:true,personalBound:true,backupCreated:true,issuer,backupFile};
    }finally{backup.fill(0);}
  });
}
export async function restorePersonalDeveloperMaster({productRoot,personalPassword,recoveryPassword,backupFile,expectedFingerprint}){
  return withLock(productRoot,()=>withPersonalIdentity(productRoot,personalPassword,async(password,identity)=>{
    const bytes=await readMasterFile(backupFile);let opened,store;
    try{
      opened=await unseal(bytes,recoveryPassword,'recovery');
      if(opened.issuer.fingerprintSha256!==expectedFingerprint)fail('BONNI_MASTER_IDENTITY_MISMATCH');
      const trust=await readDeveloperMasterTrust(productRoot);
      if(trust && !sameIssuer(trust.issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
      if(!trust){
        const old=await readMasterFile(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),{optional:true,privateAccess:true});
        try{if(old && !sameIssuer(parseStoredBundle(old).issuer,opened.issuer))fail('BONNI_MASTER_TRUST_CONFLICT');}
        finally{old?.fill(0);}
      }
      store=await seal(opened.privateKey,opened.issuer,identity.vaultId,password,'personal');
      await unseal(store,password,'personal');
      await replacePrivate(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),store);
      await installTrust(productRoot,opened.issuer);
      await withPersonalStore(productRoot,password,identity.vaultId,()=>true);
      await recordBackup(productRoot,bytes,opened.privateKey,opened.issuer);
      return {restored:true,personalBound:true,backupCreated:true,issuer:opened.issuer};
    }finally{bytes.fill(0);store?.fill(0);if(opened)opened.privateKey=null;}
  }));
}
// Used only after the CLI verifies possession of a trusted encrypted PEM.
export async function importPersonalDeveloperMaster({productRoot,personalPassword,privateKey}){
  return withLock(productRoot,()=>withPersonalIdentity(productRoot,personalPassword,async(password,identity)=>{
    const issuer=masterPublicEntry(privateKey),status=await getDeveloperMasterStatus({productRoot});
    if(status.hasPrivateKey)fail('BONNI_MASTER_ALREADY_CONFIGURED');
    if(status.issuer && !sameIssuer(status.issuer,issuer))fail('BONNI_MASTER_TRUST_CONFLICT');
    const store=await seal(privateKey,issuer,identity.vaultId,password,'personal');
    try{
      await unseal(store,password,'personal');
      await writeNew(path.join(productRoot,MASTER_STORE_RELATIVE_FILE),store);
      await installTrust(productRoot,issuer);
      await withPersonalStore(productRoot,password,identity.vaultId,()=>true);
      return {imported:true,personalBound:true,issuer};
    }finally{store.fill(0);}
  }));
}
