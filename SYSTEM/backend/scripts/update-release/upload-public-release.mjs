#!/usr/bin/env node
// Called only by the publisher after signing. Never shipped credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {hashFile} from './prepare-public-release.mjs';

const repository='Bonni-Community/bonni-core';
export async function reconcilePublicUpdate({tag,files,request}) {
  if(!/^v\d+\.\d+\.\d+(?:\+[a-z])?$/.test(tag))throw Error('PUBLIC_RELEASE_TAG_INVALID');
  const repo=await request('GET',`/repos/${repository}`);
  if(repo.private!==false)throw Error('PUBLIC_RELEASE_REPOSITORY_NOT_PUBLIC');
  const release=await request('GET',`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  if(!Number.isSafeInteger(release.id)||release.tag_name!==tag||release.draft||release.prerelease||release.immutable)throw Error('PUBLIC_RELEASE_NOT_EDITABLE_STABLE_RELEASE');
  if(files.length!==2)throw Error('PUBLIC_RELEASE_ASSET_PAIR_REQUIRED');
  const [archive,manifestFile]=files;
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  const archiveName=path.basename(archive),manifestName=path.basename(manifestFile);
  const expectedUrl=`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${archiveName}`;
  if(!/^Bonni-Core-Update-v[0-9a-z.-]+-(AMD64|ARM64|ARMv7)-[a-f0-9]{64}\.oci$/.test(archiveName)
    ||!/^manifest-(AMD64|ARM64|ARMv7)\.json$/.test(manifestName)
    ||manifest.version!==tag.slice(1)||manifest.artifact?.source?.url!==expectedUrl
    ||manifest.artifact.sha256!==await hashFile(archive)||(await fs.stat(archive)).size!==manifest.artifact.sizeBytes)throw Error('PUBLIC_RELEASE_ASSET_PAIR_INVALID');
  const assets=[];
  for(let page=1;page<=100;page++){
    const batch=await request('GET',`/repos/${repository}/releases/${release.id}/assets?per_page=100&page=${page}`);
    if(!Array.isArray(batch))throw Error('PUBLIC_RELEASE_ASSET_RESPONSE_INVALID');
    assets.push(...batch);if(batch.length<100)break;if(page===100)throw Error('PUBLIC_RELEASE_TOO_MANY_ASSETS');
  }
  // Immutable archive first, architecture manifest last. Other assets/tags and
  // the release description are untouched. Archive failure leaves the old manifest.
  for(const file of files){
    const name=path.basename(file),digest='sha256:'+await hashFile(file),size=(await fs.stat(file)).size;
    const old=assets.filter(a=>a.name===name);
    if(old.length>1)throw Error('PUBLIC_RELEASE_DUPLICATE_ASSET');
    if(old[0]?.state==='uploaded'&&old[0].digest===digest&&old[0].size===size)continue;
    if(old.length&&file===archive)throw Error('PUBLIC_RELEASE_IMMUTABLE_ARCHIVE_CONFLICT');
    if(old.length)await request('DELETE',`/repos/${repository}/releases/assets/${old[0].id}`);
    const uploaded=await request('POST',`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,{file,size});
    if(uploaded.state!=='uploaded'||uploaded.name!==name||uploaded.size!==size||uploaded.digest!==digest)throw Error('PUBLIC_RELEASE_UPLOAD_NOT_VERIFIED');
  }
  return {ok:true,tag,assets:files.map(file=>path.basename(file))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [directory,tag]=process.argv.slice(2);
  const token=process.env.GH_TOKEN;
  if(!directory||!tag||!token)throw Error('PUBLIC_RELEASE_DIRECTORY_TAG_AND_PUBLISHER_TOKEN_REQUIRED');
  const names=await fs.readdir(directory);
  const archive=names.filter(n=>n.endsWith('.oci')),manifest=names.filter(n=>/^manifest-(AMD64|ARM64|ARMv7)\.json$/.test(n));
  if(names.length!==2||archive.length!==1||manifest.length!==1)throw Error('PUBLIC_RELEASE_OUTPUT_NOT_CLEAN');
  const request=async(method,route,body)=>{
    const origin=method==='POST'?'https://uploads.github.com':'https://api.github.com';
    const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
    if(body){headers['Content-Type']=body.file.endsWith('.json')?'application/json':'application/octet-stream';headers['Content-Length']=String(body.size);}
    const response=await fetch(origin+route,{method,headers,redirect:'error',...(body?{body:createReadStream(body.file),duplex:'half'}:{}),signal:AbortSignal.timeout(30*60_000)});
    if(!response.ok)throw Error(`PUBLIC_RELEASE_GITHUB_HTTP_${response.status}`);
    return response.status===204?null:response.json();
  };
  console.log(JSON.stringify(await reconcilePublicUpdate({tag,files:[archive[0],manifest[0]].map(n=>path.join(directory,n)),request})));
}
