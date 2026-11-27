import {prepareInstalledAppDatabase,ensureAppDatabaseRuntime,forgetAppDatabaseRuntime} from './app-database-runtime.js';
import {getSystemRuntimeConfig} from '../../../system/runtime/index.js';
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {compareModuleVersions} from '../compatibility/module-version.js';
import {getProductRoot,getRuntimeStateRoot} from '../../../system/boot/run-system/run-system.paths.js';
import {resolveBonniProjectRoot} from '../project-root.js';
import {parseStaticTypeScriptManifest} from '../manifests/static-manifest-parser.js';
import {findModuleManifest} from '../manifests/index.js';
import {moduleDatabaseDomain} from '../loader/module-database-runtime.js';
import {getDataDomainPrismaClient,getPrismaClient} from '../../../core/database/database.js';
import {installModulePackage,activateModulePackage,deactivateModulePackage} from '../install/index.js';
import {assembleModulePrisma} from '../install/prisma-assembly.service.js';
import {deactivateRuntimeModule} from '../loader/index.js';
import {createSystemBackup} from '../../../system/routes/control-api/backup/backup.service.js';

const backendRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const appIdError=(code:string)=>Object.assign(new Error(code),{code});
const messages:Record<string,string>={
  APP_DATABASE_MIGRATION_REQUIRED:'Die vorhandene App-Datenbank benötigt eine passende Migration. Bestehende Daten werden nicht überschrieben.',
  APP_DEV_CONFIRMATION_REQUIRED:'Bitte den Hinweis zur Entwicklungsversion bestätigen.',
  APP_DATABASE_PREPARATION_REQUIRED:'Dieser Core enthält die benötigten App-Datenbankmodelle noch nicht. Es wurde nichts installiert. Der Core muss zuerst für diese App vorbereitet werden.',
  APP_DATABASE_SCHEMA_NOT_READY:'Die App-Datenbank ist noch nicht vorbereitet. Es wurde nichts installiert.',
  APP_TRUST_MISSING:'Dieser Core enthält noch keine geprüften App-Schlüssel. Bitte zuerst den aktualisierten, signierten Core bauen und installieren.',
  APP_CORE_TOO_OLD:'Für dieses App-Paket ist eine neuere Bonni-Core-Version erforderlich.',
  APP_SIGNATURE_INVALID:'Die App-Signatur ist ungültig oder der App-Schlüssel ist diesem Core nicht bekannt.',
  APP_SELECTION_CHANGED:'Das Paket hat sich seit der Auswahl geändert. Bitte die Liste neu laden.',
  APP_RELEASE_REPLAY:'Diese oder eine neuere Ausgabe wurde bereits installiert.',
  APP_INSTALL_BUSY_OR_RECOVERY_REQUIRED:'Eine App-Installation läuft oder wurde unterbrochen. Bitte den Installationsstatus prüfen.',
  APP_GITHUB_ACCESS_UNAVAILABLE:'GitHub ist nicht erreichbar oder das Repository ist nicht öffentlich zugänglich.',
  APP_BACKUP_FAILED:'Die Sicherung ist fehlgeschlagen. Die App wurde nicht ersetzt.',
  APP_INSTALL_RECOVERY_REQUIRED:'Die Installation wurde unterbrochen. Die vorherige App und die Sicherung bleiben zur Wiederherstellung erhalten.',
};
async function readModule(root:string) {
  for(const name of ['module.manifest.json','app.manifest.json','manifest.json','manifest.ts']) {
    try {const text=await fs.readFile(path.join(root,name),'utf8');return name.endsWith('.json')?JSON.parse(text):parseStaticTypeScriptManifest(text);}
    catch(e:any) {if(e.code!=='ENOENT')throw e;}
  }
  throw appIdError('APP_MODULE_MANIFEST_MISSING');
}
async function preflight(checked:any) {
  const module=await readModule(checked.appRoot);
  const key='app.'+checked.manifest.directory;
  if(module.key!==key||module.version!==checked.manifest.version)throw appIdError('APP_MODULE_MANIFEST_MISMATCH');
  const database=module.metadata?.database;
  if(database?.mode==='scoped-v1') {
    if(key!=='app.stueberlapp'||!Array.isArray(database.delegates)||!database.delegates.length)throw appIdError('APP_DATABASE_DECLARATION_INVALID');
  } else if(database?.mode!=='none')throw appIdError('APP_DATABASE_DECLARATION_INVALID');
  const db:any=getPrismaClient();
  const before=await db.installedModule.findUnique({where:{key}});
  if(before?.version&&compareModuleVersions(before.version,module.version)>0)throw appIdError('APP_VERSION_DOWNGRADE');
  if(before?.version&&before.version===module.version)throw appIdError('APP_VERSION_ALREADY_INSTALLED');
  const backup=await createSystemBackup({reason:'App-Installation '+key+' '+module.version});
  if(!backup.ok)throw appIdError('APP_BACKUP_FAILED');
  return {key,before,backup,database,manifest:module};
}
async function rollback(_checked:any,context:any) {
  await deactivateRuntimeModule(context.key);
  await forgetAppDatabaseRuntime(context.key);
  const db:any=getPrismaClient();
  if(context.before) {
    const {id,createdAt,updatedAt,...data}=context.before;
    await db.installedModule.upsert({where:{key:context.key},create:data,update:data});
    const restored=await findModuleManifest(context.key);if(restored)await assembleModulePrisma(restored);
    if(context.before.status==='ENABLED') {
      const activated=await activateModulePackage(context.key);if(!activated.ok)throw appIdError('APP_PREVIOUS_RUNTIME_NOT_RESTORED');
    }
  } else {
    const row=await db.installedModule.findUnique({where:{key:context.key}});
    await fs.rm(path.join(backendRoot,'prisma/domains/assembled/app',_checked.manifest.directory),{recursive:true,force:true});
    if(row){await db.moduleInstallEvent.deleteMany({where:{moduleId:row.id}});await db.installedModule.delete({where:{key:context.key}});}
  }
}
let servicePromise:Promise<any>|null=null;
function service() {
  if(!servicePromise)servicePromise=(async()=>{
    const module=await import(pathToFileURL(path.join(backendRoot,'scripts/apps/app-installer.mjs')).href);
    return module.createAppInstaller({productRoot:getProductRoot(),systemRoot:resolveBonniProjectRoot(),backendRoot,trustRoot:path.dirname(backendRoot),stateRoot:getRuntimeStateRoot(),preflight,rollback,
      getInstalled:async()=>{const db:any=getPrismaClient();return db.installedModule.findMany({where:{key:{startsWith:'app.'}},select:{key:true,version:true}});},
      beforeReplace:async(_checked:any,context:any)=>{if(context.before?.status==='ENABLED') {
        const result=await deactivateModulePackage(context.key);if(!result.ok)throw appIdError('APP_DEACTIVATION_FAILED');
      }
      if(context.database?.mode==='scoped-v1')await prepareInstalledAppDatabase(_checked.appRoot,_checked.manifest.appId,context.database.delegates,context.manifest);
      },
      install:async(_checked:any,context:any)=>{
        await ensureAppDatabaseRuntime(_checked.appRoot,context.key,context.manifest,true);
        const result=await installModulePackage(context.key);if(!result.ok)return result;
        const activated=await activateModulePackage(context.key);
        return {...activated,backup:context.backup};
      }});
  })();
  return servicePromise;
}
let checkerPromise:Promise<any>|null=null;
function checker() {
  if(!checkerPromise)checkerPromise=(async()=>{
    const module=await import(pathToFileURL(path.join(backendRoot,'scripts/apps/app-update-check.mjs')).href);
    const installer=await service();
    return module.createAppUpdateChecker({list:installer.list,settings:installer.settings});
  })();
  return checkerPromise;
}
export async function startAppUpdateChecker() {
  const runtime=getSystemRuntimeConfig();
  if(runtime.slotRole!=='active'||runtime.updateProbeMode)return {started:false};
  (await checker()).start();return {started:true,intervalHours:6};
}
export async function stopAppUpdateChecker() {if(checkerPromise)(await checkerPromise.catch(()=>null))?.stop();}
export const appDistributionRouter=Router();
function route(action:(req:any,service:any)=>Promise<any>) {
  return async(req:any,res:any)=>{
    try {res.json(await action(req,await service()));}
    catch(error:any) {
      const code=error.code==='ENOENT'?'APP_REQUIRED_FILE_MISSING':String(error.code||(/^APP_[A-Z_]+$/.test(error.message||'')?error.message:'APP_INSTALL_FAILED')); 
      const permissionError = code === 'EACCES' || code === 'EPERM';
      const message = permissionError
        ? 'Bonni konnte auf einen Store-Ordner nicht zugreifen. Prüfe die Rechte für den UPDATE-Ordner und die gespeicherten Store-Einstellungen.'
        : messages[code] || 'Das App-Paket konnte nicht verarbeitet werden ('+code+').';
      res.status(permissionError ? 500 : code==='APP_INSTALL_BUSY_OR_RECOVERY_REQUIRED'?409:400).json({ok:false,error:code,message});
    }
  };
}
appDistributionRouter.get('/settings',route(async(_req,s)=>({ok:true,...await s.settings()})));
appDistributionRouter.put('/settings',route(async(req,s)=>({ok:true,...await s.saveSource(req.body?.repository,req.body?.checkAutomatically)})));
appDistributionRouter.get('/packages',route(async(req,s)=>s.list({online:req.query.online==='true'})));
appDistributionRouter.post('/install',route(async(req,s)=>s.apply(req.body)));

appDistributionRouter.get('/check-status',route(async(_req,s)=>({...await s.settings(),...(await checker()).status()})));
appDistributionRouter.post('/check',route(async()=> (await checker()).check()));
