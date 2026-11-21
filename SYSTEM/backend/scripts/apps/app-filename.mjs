import {fail,versionParts} from './app-package.mjs';

// One signed archive per app/version, shared by installation and updates.
// Public filenames use ASCII; identity and integrity come from the signed manifest.
const names=new Map([
  ['STUEBERLAPP','StueberlApp'],['KONTORAPP','KontorApp'],
  ['HOCKETAPP','HocketApp'],['MEETAPP','MeetApp'],['KASSENAPP','KassenApp'],
]);
const reserved=new Set(['SYSTEM','WINDOWS','LINUX','CONTAINER','BONNI-CORE']);
function technicalVersion(value) {
  if(typeof value!=='string')fail('APP_VERSION_INVALID');
  const version=value.toLowerCase().replace(/(\d)([a-z])(?=-dev\.|$)/,'$1+$2');
  versionParts(version);
  return version;
}
export function appArchiveFilename(appId,version) {
  if(typeof appId!=='string'||!/^[A-Z][A-Z0-9._-]{1,63}$/.test(appId)||reserved.has(appId))fail('APP_FILENAME_INVALID');
  const visible=technicalVersion(version).replace('+','').replace('-dev.','-DEV.');
  return (names.get(appId)||appId)+'-v'+visible+'.zip';
}
export function isAppArchiveFilename(name) {
  if(typeof name!=='string'||name.length>200||/^Bonni-Core-/i.test(name))return false;
  // Keep existing published archives and local packages readable.
  if(/^[A-Za-z0-9._+-]+-App-v[A-Za-z0-9._+-]+\.zip$/.test(name))return true;
  const match=/^([A-Za-z][A-Za-z0-9._-]{1,63})-v([A-Za-z0-9.+-]+)\.zip$/.exec(name);
  if(!match||reserved.has(match[1].toUpperCase()))return false;
  try {technicalVersion(match[2]);return true;}catch{return false;}
}
