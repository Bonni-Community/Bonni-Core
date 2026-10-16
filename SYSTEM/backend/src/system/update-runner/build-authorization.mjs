// Public protocol shared by Core, the independent runner and Windows.
// Package-supplied keys are never trust anchors. The installed keyring is authoritative.
import crypto from 'node:crypto';
import {parseEd25519SpkiPublicKey} from './trusted-keys.mjs';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[a-z]+)?$/;
const DAY=86400000;
export function canonicalAuthorization(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isSafeInteger(value))return String(value);
  if(Array.isArray(value))return '['+value.map(canonicalAuthorization).join(',')+']';
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalAuthorization(value[k])).join(',')+'}';
  throw Error('BUILD_AUTHORIZATION_INVALID');
}
function exact(value,keys){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==keys.slice().sort().join(','))throw Error('BUILD_AUTHORIZATION_FIELDS_INVALID');
}
function date(value){
  if(typeof value!=='string'||value.length!==24||new Date(Date.parse(value)).toISOString()!==value)throw Error('BUILD_AUTHORIZATION_DATE_INVALID');
  return Date.parse(value);
}
function parseCertificate(c,build){
  exact(c,['schema','product','keyId','publicKey','issuerKeyId','issuedAt','expiresAt','signature',...(build?['version','channel','sourceSha256']:[])]);
  if(c.schema!==(build?'bonni.core-build-certificate/v1':'bonni.core-signer-certificate/v1')||c.product!=='bonni-core'||!ID.test(c.keyId)||!ID.test(c.issuerKeyId)||c.keyId===c.issuerKeyId)throw Error('BUILD_AUTHORIZATION_SCOPE_INVALID');
  if(typeof c.publicKey!=='string'||c.publicKey.length>1024)throw Error('BUILD_AUTHORIZATION_KEY_INVALID');
  parseEd25519SpkiPublicKey(c.publicKey);
  const start=date(c.issuedAt),end=date(c.expiresAt);
  if(end<=start||end-start>(build?90:366)*DAY)throw Error('BUILD_AUTHORIZATION_VALIDITY_INVALID');
  if(build&&(!VERSION.test(c.version)||c.channel!=='stable'||!/^[a-f0-9]{64}$/.test(c.sourceSha256)))throw Error('BUILD_AUTHORIZATION_SCOPE_INVALID');
  exact(c.signature,['algorithm','value']);
  if(c.signature.algorithm!=='Ed25519'||! /^[A-Za-z0-9+/]{86}==$/.test(c.signature.value)||Buffer.from(c.signature.value,'base64').toString('base64')!==c.signature.value)throw Error('BUILD_AUTHORIZATION_SIGNATURE_INVALID');
  return c;
}
export function parseCoreSignerCertificate(value){return parseCertificate(value,false);}
export function parseBuildAuthorization(value){
  exact(value,['schema','coreCertificates','buildCertificate']);
  if(value.schema!=='bonni.core-build-authorization/v1'||!Array.isArray(value.coreCertificates)||value.coreCertificates.length>8)throw Error('BUILD_AUTHORIZATION_INVALID');
  value.coreCertificates.forEach(c=>parseCertificate(c,false));
  parseCertificate(value.buildCertificate,true);
  const ids=[...value.coreCertificates,value.buildCertificate].map(c=>c.keyId);
  if(new Set(ids).size!==ids.length)throw Error('BUILD_AUTHORIZATION_DUPLICATE_KEY');
  return value;
}
function certificateBytes(c){const {signature,...payload}=c;return Buffer.from('BONNI_CORE_KEY_CERTIFICATE_V1\n'+canonicalAuthorization(payload)+'\n');}
export function signCoreCertificate(payload,privateKey){
  const key=privateKey instanceof crypto.KeyObject?privateKey:crypto.createPrivateKey(privateKey);
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw Error('BUILD_AUTHORIZATION_PRIVATE_KEY_INVALID');
  const signed={...payload,signature:{algorithm:'Ed25519',value:crypto.sign(null,certificateBytes(payload),key).toString('base64')}};
  return parseCertificate(signed,payload.schema==='bonni.core-build-certificate/v1');
}
export function verifyBuildAuthorization(authorization,{trustedKeys,version,product='bonni-core',channel='stable',keyId,now=new Date(),issuedAt,expiresAt,sourceSha256}={}){
  const value=parseBuildAuthorization(authorization),build=value.buildCertificate;
  if(product!=='bonni-core'||build.product!==product||build.version!==version||build.channel!==channel||build.keyId!==keyId||(sourceSha256!==undefined&&sourceSha256!==build.sourceSha256))throw Error('BUILD_AUTHORIZATION_TARGET_MISMATCH');
  const timestamp=now.getTime();
  if(!Number.isFinite(timestamp))throw Error('BUILD_AUTHORIZATION_DATE_INVALID');
  const certificates=new Map(value.coreCertificates.map(c=>[c.keyId,c]));
  const visited=new Set();
  function trusted(id){return trustedKeys instanceof Map?trustedKeys.get(id):Object.hasOwn(trustedKeys||{},id)?trustedKeys[id]:undefined;}
  function verifyCertificate(cert){
    if(visited.has(cert.keyId))throw Error('BUILD_AUTHORIZATION_CYCLE');visited.add(cert.keyId);
    const start=date(cert.issuedAt),end=date(cert.expiresAt);
    if(timestamp+300000<start||timestamp-300000>end)throw Error('BUILD_AUTHORIZATION_EXPIRED');
    if(issuedAt!==undefined&&Date.parse(issuedAt)<start)throw Error('BUILD_AUTHORIZATION_RELEASE_TIME_INVALID');
    if(expiresAt!==undefined&&Date.parse(expiresAt)>end)throw Error('BUILD_AUTHORIZATION_RELEASE_TIME_INVALID');
    let issuer=trusted(cert.issuerKeyId);
    if(!issuer){const parent=certificates.get(cert.issuerKeyId);if(!parent)throw Error('UNTRUSTED_BUILD_AUTHORITY');verifyCertificate(parent);if(start<date(parent.issuedAt)||end>date(parent.expiresAt))throw Error('BUILD_AUTHORIZATION_VALIDITY_ESCALATION');issuer=parent.publicKey;}
    if(!crypto.verify(null,certificateBytes(cert),parseEd25519SpkiPublicKey(issuer),Buffer.from(cert.signature.value,'base64')))throw Error('BUILD_AUTHORIZATION_SIGNATURE_INVALID');
  }
  verifyCertificate(build);
  return parseEd25519SpkiPublicKey(build.publicKey);
}
