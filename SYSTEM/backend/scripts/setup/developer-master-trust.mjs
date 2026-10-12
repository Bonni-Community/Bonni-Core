import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export const MASTER_TRUST_SCHEMA='bonni.developer-authority/v1';
export const MASTER_TRUST_RELATIVE_FILE=path.join('SYSTEM','DEVELOPER-AUTHORITY.json');
export const MASTER_STORE_RELATIVE_FILE=path.join('SIGNATUR','PRIVATE','BONNI-DEVELOPER-MASTER.bonni');
export function masterFail(code){const error=new Error(code);error.code=code;throw error;}
export function exactMasterFields(value,fields){
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join('|')!==[...fields].sort().join('|')) masterFail('BONNI_MASTER_FORMAT_INVALID');
}
export function masterPublicEntry(key){
  const publicKey=crypto.createPublicKey(key),der=publicKey.export({type:'spki',format:'der'});
  if(publicKey.asymmetricKeyType!=='ed25519') masterFail('BONNI_MASTER_KEY_INVALID');
  const fingerprintSha256=crypto.createHash('sha256').update(der).digest('hex');
  return {keyId:'bonni-master-'+fingerprintSha256.slice(0,32),algorithm:'Ed25519',
    publicKeyPem:publicKey.export({type:'spki',format:'pem'}),fingerprintSha256};
}
export function parseMasterPublicEntry(raw){
  exactMasterFields(raw,['keyId','algorithm','publicKeyPem','fingerprintSha256']);
  if(typeof raw.publicKeyPem!=='string' || raw.publicKeyPem.length>1024 || !raw.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) masterFail('BONNI_MASTER_KEY_INVALID');
  let derived;try{derived=masterPublicEntry(raw.publicKeyPem);}catch{masterFail('BONNI_MASTER_KEY_INVALID');}
  if(Object.keys(derived).some(k=>raw[k]!==derived[k])) masterFail('BONNI_MASTER_KEY_INVALID');
  return Object.freeze(derived);
}
export function parseMasterTrust(raw){
  exactMasterFields(raw,['schema','issuer']);
  if(raw.schema!==MASTER_TRUST_SCHEMA)masterFail('BONNI_MASTER_FORMAT_INVALID');
  return {schema:MASTER_TRUST_SCHEMA,issuer:parseMasterPublicEntry(raw.issuer)};
}
export async function assertMasterPath(file,{parent=false,missing=false}={}){
  if(typeof file!=='string' || !path.isAbsolute(file))masterFail('BONNI_MASTER_PATH_INVALID');
  const full=path.resolve(file),target=parent?path.dirname(full):full;
  let cursor=path.parse(target).root;
  for(const segment of target.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,segment);
    let st;try{st=await fs.lstat(cursor);}catch(e){if(missing && e.code==='ENOENT')return false;throw e;}
    if(st.isSymbolicLink() || (cursor!==target && !st.isDirectory()) || (parent && !st.isDirectory()))masterFail('BONNI_MASTER_PATH_UNSAFE');
  }
  return true;
}
export async function readMasterFile(file,{optional=false,privateAccess=false}={}){
  if(!await assertMasterPath(file,{missing:optional}))return null;
  const before=await fs.lstat(file);
  if(!before.isFile() || before.nlink!==1 || before.size<2 || before.size>32768 ||
    (privateAccess && process.platform!=='win32' && ((before.mode&0o077)!==0 || (process.getuid && before.uid!==process.getuid()))))masterFail('BONNI_MASTER_FILE_UNSAFE');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat();
    if(opened.dev!==before.dev || opened.ino!==before.ino || opened.size!==before.size)masterFail('BONNI_MASTER_FILE_UNSAFE');
    const buffer=Buffer.alloc(32769);
    try{
      const {bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
      if(bytesRead!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)masterFail('BONNI_MASTER_FILE_CHANGED');
      return Buffer.from(buffer.subarray(0,bytesRead));
    }finally{buffer.fill(0);}
  }finally{await handle.close();}
}
export function parseMasterJson(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{masterFail('BONNI_MASTER_FORMAT_INVALID');}}
export async function readDeveloperMasterTrust(productRoot){
  if(typeof productRoot!=='string' || !path.isAbsolute(productRoot))masterFail('BONNI_MASTER_PATH_INVALID');
  const bytes=await readMasterFile(path.join(productRoot,MASTER_TRUST_RELATIVE_FILE),{optional:true});
  if(!bytes)return null;
  try{return parseMasterTrust(parseMasterJson(bytes));}finally{bytes.fill(0);}
}
