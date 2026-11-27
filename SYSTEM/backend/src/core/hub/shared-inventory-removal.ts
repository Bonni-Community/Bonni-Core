import {getPrismaClient} from '../database/prisma.js';
import {hubRemovalBlock} from './hub-installation-policy.js';

export async function sharedInventoryRemovalBlock(key:string,modules:any[],manifests:any[]=[]){
 const installedRule=hubRemovalBlock(key,modules,manifests);
 if(installedRule||key!=='addon.hub')return installedRule;
 const setting=await getPrismaClient().systemSetting.findUnique({where:{key:'bonni.hub.inventory-mode.v1'}});
 if(!(setting?.value as any)?.everShared)return null;
 return {ok:false as const,error:'HUB_SHARED_STOCK_EXPORT_REQUIRED',key,message:'Der gemeinsame Lagerbestand liegt in Hub. Vor dem Entfernen ist ein bestätigter Rücktransfer erforderlich.'};
}
