#!/usr/bin/env node
import {verifyBuildAuthorization} from '../../src/system/update-runner/build-authorization.mjs';
// Publisher-side command. The installed Core never uses a GitHub token or a
// private signing key. The archive must already carry repository:version.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {inspectCoreDockerArchivePayload} from '../../src/system/update-runner/archive-tags.mjs';
import {bonniReleaseImageTag,verifyReleaseManifest} from '../../dist/system/update-release/index.js';

const execute=promisify(execFile);
export async function hashFile(file) {
  const hash=crypto.createHash('sha256');
  for await(const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function preparePublicRelease({archive,version,privateKey,keyId,trust,outputDir,buildAuthorization}) {
  const imageTag=bonniReleaseImageTag(version);
  const identity=await inspectCoreDockerArchivePayload(archive,{version});
  const architecture=identity.platform.architecture;
  const label={amd64:'AMD64',arm64:'ARM64',arm:'ARMv7'}[architecture];
  if(!label||identity.platform.os!=='linux'||(architecture==='arm'&&identity.platform.variant!=='v7')) throw Error('PUBLIC_RELEASE_PLATFORM_UNSUPPORTED');
  if(identity.tags.length!==1||!identity.tags[0].endsWith(':'+imageTag)) throw Error('PUBLIC_RELEASE_EXACT_VERSION_TAG_REQUIRED');
  const repository=identity.tags[0].slice(0,-imageTag.length-1);
  const privatePem=await fs.readFile(privateKey,'utf8');
  const publicKey=crypto.createPublicKey(privatePem);
  const enrolled=JSON.parse(await fs.readFile(trust,'utf8'));
  if(enrolled.schema!=='bonni.app-install-trust/v1'||!Array.isArray(enrolled.keys))throw Error('PUBLIC_RELEASE_TRUST_INVALID');
  const trustedKeys=Object.fromEntries(enrolled.keys.filter(k=>k.scopes?.includes('RELEASE')).map(k=>[k.keyId,k.publicKey]));
  const enrolledKey=buildAuthorization?verifyBuildAuthorization(buildAuthorization,{trustedKeys,keyId,version}):trustedKeys[keyId]&&crypto.createPublicKey(trustedKeys[keyId]);
  if(!enrolledKey||!enrolledKey.equals(publicKey)) throw Error('PUBLIC_RELEASE_KEY_NOT_ENROLLED');
  const sha=await hashFile(archive);
  const artifactName=`Bonni-Core-Update-v${imageTag}-${label}-${sha}.oci`;
  const tag='v'+version;
  const artifactUrl=`https://github.com/Bonni-Community/bonni-core/releases/download/${encodeURIComponent(tag)}/${artifactName}`;
  const stage=await fs.mkdtemp(path.join(path.dirname(path.resolve(outputDir)),'.bonni-update-sign-'));
  try {
    const authorizationFile=path.join(stage,'authorization.json');
    if(buildAuthorization)await fs.writeFile(authorizationFile,JSON.stringify(buildAuthorization),{mode:0o600,flag:'wx'});
    const delegationArgs=buildAuthorization?['--build-authorization',authorizationFile,'--trusted-keys',path.resolve(trust)]:[];
    // create-release insists on a clean output directory.
    const signingOutput=path.join(stage,'signed');
    await execute(process.execPath,[path.join(import.meta.dirname,'create-release.mjs'),
      '--archive',path.resolve(archive),'--image',repository+'@'+identity.digest,'--version',version,
      '--private-key',path.resolve(privateKey),'--key-id',keyId,'--output-dir',signingOutput,
      '--migration','offline','--artifact-url',artifactUrl,...delegationArgs],{maxBuffer:1024*1024});
    const manifest=JSON.parse(await fs.readFile(path.join(signingOutput,'manifest.json'),'utf8'));
    verifyReleaseManifest(manifest,{trustedKeys,runnerVersion:'0.5.0',nodeEnv:'production',expectedChannel:'stable'});
    if(manifest.artifact.sha256!==sha) throw Error('PUBLIC_RELEASE_ARCHIVE_CHANGED');
    // New output directory only: a failed preparation cannot mix old/new files.
    await fs.mkdir(outputDir,{mode:0o700});
    await fs.rename(path.join(signingOutput,`bonni-core-${imageTag}.oci`),path.join(outputDir,artifactName));
    const manifestName=`manifest-${label}.json`;
    await fs.rename(path.join(signingOutput,'manifest.json'),path.join(outputDir,manifestName));
    return {tag,architecture:label,files:[path.join(outputDir,artifactName),path.join(outputDir,manifestName)]};
  } finally {await fs.rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args={};
  const mapping={'--archive':'archive','--version':'version','--private-key':'privateKey','--key-id':'keyId','--trust':'trust','--output-dir':'outputDir'};
  for(let i=2;i<process.argv.length;i+=2){const key=mapping[process.argv[i]];if(!key||!process.argv[i+1]||args[key])throw Error('PUBLIC_RELEASE_ARGUMENT_INVALID');args[key]=process.argv[i+1];}
  for(const key of Object.values(mapping))if(!args[key])throw Error('PUBLIC_RELEASE_ARGUMENT_REQUIRED: '+key);
  console.log(JSON.stringify(await preparePublicRelease(args)));
}
