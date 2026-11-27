import {getPrismaClient} from '../database/prisma.js';
import {listInstalledModulesStrict} from '../../platform/module-manager/registry/index.js';
import {listModuleManifests} from '../../platform/module-manager/manifests/index.js';
import {hubInstallationPolicy} from './hub-installation-policy.js';
const KEY='bonni.hub.inventory-mode.v1';
export async function getSharedInventoryMode(){const [modules,manifests,setting]=await Promise.all([listInstalledModulesStrict(),listModuleManifests(),getPrismaClient().systemSetting.findUnique({where:{key:KEY}})]);const p=hubInstallationPolicy(modules,undefined,manifests),value=setting?.value as any,preference=['LOCAL','HUB'].includes(value?.mode)?value.mode:'AUTO';const pendingApps=p.appKeys.filter(key=>{const m=manifests.find(m=>m.key===key);return (m?.metadata?.hubInventory as any)?.adoptionRequired!==false&&!value?.sources?.[key]?.ready;});return{everShared:!!value?.everShared,pendingApps,mode:p.required||value?.everShared||preference==='HUB'?'HUB':'LOCAL',required:p.required,installed:p.installed,enabled:p.enabled,appKeys:p.appKeys,preference};}
async function updateSetting(change: (prior:any)=>any) {
  const db=getPrismaClient();
  for(let attempt=0;;attempt++) {
    try {return await db.$transaction(async(tx:any)=>{
      const prior=(await tx.systemSetting.findUnique({where:{key:KEY}}))?.value||{};
      const value=change(prior);
      await tx.systemSetting.upsert({where:{key:KEY},create:{key:KEY,value},update:{value}});
    },{isolationLevel:'Serializable'});}
    catch(error:any){if(!['P2034','P2002'].includes(error?.code)||attempt>=3)throw error;}
  }
}
export async function configureSharedInventoryMode(moduleKey:string,input:any){
  if(!input||Object.keys(input).some(k=>k!=='mode')||!['LOCAL','HUB'].includes(input.mode))throw Object.assign(new Error('HUB_INVENTORY_INPUT_INVALID'),{code:'HUB_INVENTORY_INPUT_INVALID',statusCode:400});
  const current=await getSharedInventoryMode();
  if(input.mode==='LOCAL'&&(current.required||current.everShared))throw Object.assign(new Error(current.required?'HUB_REQUIRED_FOR_MULTIPLE_APPS':'HUB_SHARED_STOCK_EXPORT_REQUIRED'),{code:current.required?'HUB_REQUIRED_FOR_MULTIPLE_APPS':'HUB_SHARED_STOCK_EXPORT_REQUIRED',statusCode:409});
  if(input.mode==='HUB'&&(!current.installed||!current.enabled))throw Object.assign(new Error('HUB_UNAVAILABLE'),{code:'HUB_UNAVAILABLE',statusCode:503});
  await updateSetting(prior=>{if(input.mode==='LOCAL'&&prior.everShared)throw Object.assign(new Error('HUB_SHARED_STOCK_EXPORT_REQUIRED'),{code:'HUB_SHARED_STOCK_EXPORT_REQUIRED',statusCode:409});return {...prior,mode:input.mode,everShared:!!prior.everShared,moduleKey,updatedAt:new Date().toISOString()};});
  return getSharedInventoryMode();
}
export async function markSharedInventory(){await updateSetting(prior=>({...prior,mode:'HUB',everShared:true}));}
export async function confirmInventorySource(moduleKey:string,actorAccountId:string){
  await updateSetting(prior=>({...prior,mode:'HUB',everShared:true,sources:{...prior.sources,[moduleKey]:{ready:true,actorAccountId,confirmedAt:new Date().toISOString()}}}));
  return getSharedInventoryMode();
}
