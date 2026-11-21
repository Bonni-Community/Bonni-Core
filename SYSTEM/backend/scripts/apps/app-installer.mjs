import {isAppArchiveFilename} from './app-filename.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractUpdateZip} from './safe-update-zip.mjs';
import {verifyApp,loadAppTrust,readFile,plainDirectory,sha256,fail,compareVersions,inventory,canonical} from './app-package.mjs';
import {repository,listGitHubApps,downloadApp} from './github-download.mjs';

// No shell command or package-manager download belongs to target installation.
export function createAppInstaller({productRoot,systemRoot,backendRoot,stateRoot,trustRoot=systemRoot,preflight,beforeReplace,install,rollback,getInstalled=async()=>[],fetchImpl=fetch}) {
  const inbox=path.join(productRoot,'UPDATE');
  const home=path.join(stateRoot,'app-install');
  async function init() {
    for(const root of [productRoot,systemRoot,stateRoot])await plainDirectory(root);
    for(const dir of [inbox,home]) {await fs.mkdir(dir,{recursive:true,mode:0o700});await plainDirectory(dir);}
  }
  async function settings() {
    await init();
    try {const s=JSON.parse(await readFile(path.join(home,'source.json')));return {repository:s.repository===''?'':repository(s.repository),checkAutomatically:s.checkAutomatically!==false,inbox};}
    catch(e){if(e.code==='ENOENT')return {repository:'',checkAutomatically:true,inbox};throw e;}
  }
  async function saveSource(value,checkAutomatically) {
    const current=await settings();
    if(checkAutomatically!==undefined&&typeof checkAutomatically!=='boolean')fail('APP_SETTINGS_INVALID');
    const repo=value===''?'':repository(value);await init();
    const file=path.join(home,randomUUID()+'.tmp');
    await fs.writeFile(file,JSON.stringify({repository:repo,checkAutomatically:checkAutomatically??current.checkAutomatically})+'\n',{flag:'wx',mode:0o600});await fs.rename(file,path.join(home,'source.json'));
    return {repository:repo,checkAutomatically:checkAutomatically??current.checkAutomatically,inbox};
  }
  async function corePolicy() {
    const pkg=JSON.parse(await readFile(path.join(backendRoot,'package.json')));
    return {coreVersion:pkg.version,trustedKeys:await loadAppTrust(path.join(trustRoot,'APP-INSTALL-TRUST.json'))};
  }
  async function receipt(directory) {
    try {return JSON.parse(await readFile(path.join(home,directory+'.json')));}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function inspect(bytes,work,expected={},forListing=false) {
    const zip=path.join(work,'package.zip');await fs.writeFile(zip,bytes,{flag:'wx',mode:0o600});
    const root=path.join(work,'PACKAGE');await extractUpdateZip(zip,root);
    const policy=await corePolicy();
    const checked=await verifyApp({root,...policy,coreVersion:forListing?undefined:policy.coreVersion});
    const m=checked.manifest;
    if(expected.appId&&m.appId!==expected.appId||expected.version&&m.version!==expected.version)fail('APP_SELECTION_CHANGED');
    const previous=await receipt(m.directory);
    if(previous&&previous.releaseSequence>=m.releaseSequence) {
      if(previous.sha256===sha256(bytes)&&previous.status==='installed'){
        const live=await inventory(path.join(systemRoot,'app',m.directory)).catch(()=>null);
        if(live?.treeSha256!==m.treeSha256)fail('APP_INSTALLED_STATE_CHANGED');
        return {...checked,alreadyInstalled:true};
      }
      fail('APP_RELEASE_REPLAY');
    }
    if(previous?.version&&compareVersions(m.version,previous.version)<0)fail('APP_VERSION_DOWNGRADE');
    return checked;
  }
  async function list({online=false}={}) {
    await init();const local=[];let localError=null;
    // Scan the inbox first. A failed network request must never hide local packages.
    try {
      const files=(await fs.readdir(inbox,{withFileTypes:true})).filter(e=>e.isFile()&&isAppArchiveFilename(e.name));
      if(files.length>40)fail('APP_INBOX_TOO_MANY_PACKAGES');
      for(const entry of files) {
        const work=await fs.mkdtemp(path.join(home,'scan-'));
        try {
          const bytes=await readFile(path.join(inbox,entry.name),512*1024*1024);
          const info=await inspect(bytes,work,{},true);
          local.push({source:'offline',filename:entry.name,sha256:sha256(bytes),...info.manifest,files:undefined,alreadyInstalled:info.alreadyInstalled===true,signatureVerified:true});
        } catch(e) {local.push({source:'offline',filename:entry.name,error:e.code||'APP_PACKAGE_INVALID'});}
        finally {await fs.rm(work,{recursive:true,force:true});}
      }
    } catch(e) {localError=e.code||'APP_INBOX_UNAVAILABLE';}
    const source=await settings();let remote=[],onlineError=null;
    let onlineState=online?(source.repository?'checking':'not_configured'):'not_checked';
    if(online&&source.repository)try {
      // The actual GitHub request also tests reachability; no unrelated Internet probe.
      remote=await listGitHubApps(source.repository,{fetchImpl,signal:AbortSignal.timeout(15000),timeoutMs:15000});
      onlineState='reachable';
    } catch(e) {onlineError=e.code||'APP_ONLINE_UNAVAILABLE';onlineState='unavailable';}
    let installed=[],installedError=null,coreVersion;
    try {installed=await getInstalled();coreVersion=JSON.parse(await readFile(path.join(backendRoot,'package.json'))).version;}
    catch(e) {installedError='APP_INSTALLED_VERSIONS_UNAVAILABLE';}
    function describe(item) {
      if(item.error)return item;
      const current=installed.find(row=>row.key==='app.'+item.appId.toLowerCase());
      let versionStatus=item.alreadyInstalled?'installed':'new',error=item.error;
      if(installedError)versionStatus='unknown';
      try {
        if(current?.version) {
          const order=compareVersions(item.version,current.version);
          versionStatus=order>0?'update':order===0?'installed':'older';
        }
        if(coreVersion&&compareVersions(coreVersion,item.minimumCoreVersion)<0)error='APP_CORE_TOO_OLD';
      } catch {versionStatus='unknown';}
      return {...item,installedVersion:current?.version||null,versionStatus,alreadyInstalled:versionStatus==='installed',
        updateAvailable:versionStatus==='update',error};
    }
    const localItems=local.map(describe),remoteItems=remote.map(item=>describe({...item,source:'online',signatureVerified:false}));
    const updates=[...localItems,...remoteItems].filter(item=>item.updateAvailable&&(!item.error||item.error==='APP_CORE_TOO_OLD'));
    const latest=new Map();
    for(const item of updates) {
      const previous=latest.get(item.appId);
      const order=previous?compareVersions(item.version,previous.version):1;
      if(!previous||order>0||(order===0&&item.releaseSequence>previous.releaseSequence))latest.set(item.appId,item);
      // On equal version/sequence keep the local signed package encountered first.
    }
    return {ok:true,...source,local:localItems,remote:remoteItems,localError,onlineError,onlineState,installedError,
      checkedAt:new Date().toISOString(),updateCount:latest.size,availableUpdates:[...latest.values()]};
  }
  async function apply(request) {
    if(!request||!['offline','online'].includes(request.source)||!/^[a-f0-9]{64}$/.test(request.sha256||'')
      ||!/^APP:[A-Z][A-Z0-9._-]{1,63}$/.test('APP:'+request.appId)||typeof request.version!=='string')fail('APP_INSTALL_REQUEST_INVALID');
    await init();const lock=path.join(home,'LOCK');
    await fs.mkdir(lock,{mode:0o700}).catch(e=>{if(e.code==='EEXIST')fail('APP_INSTALL_BUSY_OR_RECOVERY_REQUIRED');throw e;});
    const work=path.join(lock,'WORK');await fs.mkdir(work);let staging,destination,previous,hadPrevious=false,moved=false,context,checked,recovery=false;
    try {
      let bytes;
      if(request.source==='offline') {
        if(!isAppArchiveFilename(request.filename||''))fail('APP_FILENAME_INVALID');
        bytes=await readFile(path.join(inbox,request.filename),512*1024*1024);
      } else {
        const config=await settings();
        const entries=await listGitHubApps(config.repository,{fetchImpl});
        const selected=entries.find(e=>e.appId===request.appId&&e.version===request.version&&e.sha256===request.sha256);
        if(!selected)fail('APP_SELECTION_CHANGED');
        bytes=await downloadApp(selected,config.repository,{fetchImpl});
        // The fixed UPDATE inbox is shared by both installation paths.
        const downloaded=path.join(inbox,selected.filename),temporary=path.join(inbox,'.bonni-'+randomUUID()+'.part');
        await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});
        try {await fs.link(temporary,downloaded).catch(async e=>{
          if(e.code!=='EEXIST')throw e;
          if(sha256(await readFile(downloaded,512*1024*1024))!==selected.sha256)fail('APP_INBOX_FILENAME_CONFLICT');
        });} finally {await fs.unlink(temporary);}
        bytes=await readFile(downloaded,512*1024*1024);
      }
      if(sha256(bytes)!==request.sha256)fail('APP_SELECTION_CHANGED');
      checked=await inspect(bytes,work,request);
      if(checked.manifest.channel==='dev'&&request.acceptDevRisk!==true)fail('APP_DEV_CONFIRMATION_REQUIRED');
      if(checked.alreadyInstalled)return {ok:true,alreadyInstalled:true,appId:request.appId,version:request.version};
      if(typeof preflight!=='function'||typeof install!=='function'||typeof rollback!=='function')fail('APP_INSTALL_ADAPTER_MISSING');
      const appDirectory=path.join(systemRoot,'app');await fs.mkdir(appDirectory,{recursive:true});await plainDirectory(appDirectory);
      destination=path.join(appDirectory,checked.manifest.directory);
      const old=await fs.lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(old&&(!old.isDirectory()||old.isSymbolicLink()))fail('APP_DIRECTORY_UNSAFE');
      staging=await fs.mkdtemp(path.join(appDirectory,'.bonni-install-'));
      previous=path.join(staging,'PREVIOUS');
      const next=path.join(staging,'NEXT');await fs.cp(checked.appRoot,next,{recursive:true,errorOnExist:true,force:false});
      if(canonical((await inventory(next)).files)!==canonical(checked.manifest.files))fail('APP_PAYLOAD_CHANGED');
      context=await preflight(checked);
      await beforeReplace?.(checked,context);
      await fs.writeFile(path.join(lock,'transaction.json'),JSON.stringify({appId:request.appId,version:request.version,sha256:request.sha256,destination,previous})+'\n',{flag:'wx',mode:0o600});
      if(old){await fs.rename(destination,previous);hadPrevious=true;}
      await fs.rename(next,destination);moved=true;
      const result=await install({...checked,appRoot:destination},context);
      if(result?.ok!==true)fail(result?.error||'APP_INSTALL_NOT_CONFIRMED');
      const state={status:'installed',appId:request.appId,version:checked.manifest.version,releaseSequence:checked.manifest.releaseSequence,sha256:request.sha256,installedAt:new Date().toISOString()};
      const pending=path.join(lock,'state.json');await fs.writeFile(pending,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});
      // Preserve exactly the previous app tree; a failed attempt never deletes it.
      if(hadPrevious){const backup=path.join(appDirectory,'.bonni-'+checked.manifest.directory+'-backup-'+randomUUID());await fs.rename(previous,backup);previous=backup;}
      await fs.rename(pending,path.join(home,checked.manifest.directory+'.json'));
      moved=false;hadPrevious=false;
      return {ok:true,...state,result};
    } catch(error) {
      try {
        if(moved)await fs.rm(destination,{recursive:true,force:true});
        if(hadPrevious)await fs.rename(previous,destination);
        if(context)await rollback(checked,context);
      } catch {recovery=true;fail('APP_INSTALL_RECOVERY_REQUIRED');}
      throw error;
    } finally {if(!recovery){if(staging)await fs.rm(staging,{recursive:true,force:true});await fs.rm(lock,{recursive:true,force:true});}}
  }
  return {settings,saveSource,list,apply};
}
