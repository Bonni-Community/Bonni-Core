import {isAppArchiveFilename} from './app-filename.mjs';
import {fail,sha256,versionParts} from './app-package.mjs';
export function repository(value) {
  if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value||'')||value.endsWith('.'))fail('APP_REPOSITORY_INVALID');
  return value;
}
function allowed(url) {
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port
    &&['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname);
}
export async function githubBytes(address,{limit=1024*1024,token,fetchImpl=fetch,signal,timeoutMs=120000}={}) {
  let url=new URL(address);
  for(let redirects=0;redirects<5;redirects++) {
    if(!allowed(url))fail('APP_DOWNLOAD_HOST_DENIED');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const headers={Accept:url.hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'};
      if(token&&url.hostname==='api.github.com')headers.Authorization='Bearer '+token;
      const response=await fetchImpl(url.toString(),{headers,redirect:'manual',signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
      if([301,302,303,307,308].includes(response.status)) {
        const next=response.headers.get('location');await response.body?.cancel();
        if(!next)fail('APP_DOWNLOAD_REDIRECT_INVALID');url=new URL(next,url);continue;
      }
      if(response.status===401||response.status===403||response.status===404)fail('APP_GITHUB_ACCESS_UNAVAILABLE');
      if(!response.ok)fail('APP_DOWNLOAD_HTTP_'+response.status);
      if(Number(response.headers.get('content-length'))>limit)fail('APP_DOWNLOAD_TOO_LARGE');
      if(!response.body)fail('APP_DOWNLOAD_EMPTY');
      const parts=[];let size=0;
      for await(const part of response.body){size+=part.length;if(size>limit){controller.abort();fail('APP_DOWNLOAD_TOO_LARGE');}parts.push(Buffer.from(part));}
      return Buffer.concat(parts);
    } finally {clearTimeout(timer);}
  }
  fail('APP_DOWNLOAD_REDIRECT_LIMIT');
}
export function validateCatalog(entry,repo) {
  if(!entry||entry.schema!=='bonni.app-catalog-entry/v1'||entry.repository!==repository(repo)
    ||!/^APP:[A-Z][A-Z0-9._-]{1,63}$/.test('APP:'+entry.appId)||!isAppArchiveFilename(entry.filename||'')
    ||!Number.isSafeInteger(entry.sizeBytes)||entry.sizeBytes<1||entry.sizeBytes>512*1024*1024
    ||!Number.isSafeInteger(entry.releaseSequence)||entry.releaseSequence<1||!/^[a-f0-9]{64}$/.test(entry.sha256||'')
    ||!/^[A-Za-z0-9._+-]+$/.test(entry.filename)||!/^[A-Za-z0-9._+-]+$/.test(entry.releaseTag))fail('APP_CATALOG_INVALID');
  if(entry.releaseNotes!==undefined&&(typeof entry.releaseNotes!=='string'||entry.releaseNotes.length>32000))fail('APP_CATALOG_INVALID');
  versionParts(entry.version);versionParts(entry.minimumCoreVersion);
  if(entry.channel!==(/-dev\./i.test(entry.version)?'dev':'stable'))fail('APP_CATALOG_CHANNEL_INVALID');
  const expected='https://github.com/'+repo+'/releases/download/'+encodeURIComponent(entry.releaseTag)+'/'+encodeURIComponent(entry.filename);
  if(entry.downloadUrl!==expected)fail('APP_CATALOG_URL_INVALID');
  return entry;
}
export async function listGitHubApps(repo,options={}) {
  repo=repository(repo);
  const releases=JSON.parse(await githubBytes('https://api.github.com/repos/'+repo+'/releases?per_page=30',options));
  if(!Array.isArray(releases))fail('APP_CATALOG_INVALID');
  const items=[];
  for(const release of releases.filter(r=>!r.draft)) {
    const asset=(release.assets||[]).find(a=>a.name==='BONNI-APP.json');if(!asset)continue;
    if(asset.size>64*1024||!Number.isSafeInteger(asset.id))fail('APP_CATALOG_INVALID');
    const address='https://github.com/'+repo+'/releases/download/'+encodeURIComponent(release.tag_name)+'/BONNI-APP.json';
    const entry=validateCatalog(JSON.parse(await githubBytes(address,{...options,limit:64*1024})),repo);
    if(entry.releaseTag!==release.tag_name||release.prerelease!==(entry.channel==='dev'))fail('APP_CATALOG_INVALID');
    const releaseNotes=typeof entry.releaseNotes==='string'?entry.releaseNotes:(typeof release.body==='string'?release.body.replace(/<!-- bonni-app:[\s\S]*?-->/g,'').trim().slice(0,32000):'');
    items.push({...entry,releaseNotes});
  }
  return items;
}
export async function downloadApp(entry,repo,options={}) {
  validateCatalog(entry,repo);
  const bytes=await githubBytes(entry.downloadUrl,{...options,limit:entry.sizeBytes});
  if(bytes.length!==entry.sizeBytes||sha256(bytes)!==entry.sha256)fail('APP_DOWNLOAD_CHECKSUM_MISMATCH');
  return bytes;
}
