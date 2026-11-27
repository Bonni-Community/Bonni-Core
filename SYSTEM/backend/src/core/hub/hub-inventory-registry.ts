import {hubInvocationIdentity} from "../network-requests/verified-network-invocation.js";
import {getVerifiedRequestIdentity} from '../../platform/auth/request-identity/request-identity-context.js';
import {getCoreInstanceId} from '../instance-identity/core-instance-id.js';
const VERSION='hub.inventory/v1';
const operations=['mode','configure','snapshot','prepare','finish','adopt','adoptClaims','confirmReady','history','manage','subscribe'] as const;
const reads=new Set(['snapshot','history']);
const reservationPermission = 'hub.stock.reserve';
const worksKey = 'app.worksapp';
const worksCalendarScope = 'materials';
const mayReserve = (key:string,op:string) => key===worksKey && (op==='prepare' || op==='finish');
type Provider={contractVersion:string;invoke(op:string,input:unknown,context:any):Promise<unknown>};
function fail(code:string,statusCode=503):never{throw Object.assign(new Error(code),{code,statusCode});}
export function validateHubInventoryManifest(m:any){const errors:string[]=[],deps=Array.isArray(m.dependsOn)?m.dependsOn:[],d=m.metadata?.hubInventory,rights=Array.isArray(m.permissions?.requires)?m.permissions.requires:[];
 if(d?.operations?.includes('manage')&&!deps.includes('core.hub-inventory-management'))errors.push('Physische Lagerbuchungen benötigen core.hub-inventory-management.');
 if(deps.includes('core.hub-inventory-provider')&&(m.key!=='addon.hub'||m.kind!=='addon'))errors.push('Nur Hub darf den gemeinsamen Lagervertrag bereitstellen.');
 if(deps.includes('core.hub-inventory')!==(d!==undefined))errors.push('core.hub-inventory und metadata.hubInventory müssen gemeinsam deklariert werden.');
 if(d!==undefined&&(!d||d.contractVersion!==VERSION||Object.keys(d).some(k=>!['contractVersion','operations','profilePermissions','adoptionRequired','networkPermissions'].includes(k))||!Array.isArray(d.operations)||!d.operations.length||new Set(d.operations).size!==d.operations.length||d.operations.some((op:any)=>!operations.includes(op)||!['mode','configure','subscribe'].includes(op)&&!rights.includes(reads.has(op)?'hub.stock.read':'hub.stock.write'))))errors.push('Gemeinsames Lager benötigt gültige Operationen und exakte Hub-Rechte.');if(d?.profilePermissions){const profiles=m.metadata?.accessProfiles||[];for(const [key,grants]of Object.entries(d.profilePermissions)){if(!profiles.some((p:any)=>p.key===key)||!Array.isArray(grants)||grants.some((p:any)=>(!['hub.products.read','hub.products.write','hub.stock.read','hub.stock.write'].includes(p)&&!(p===reservationPermission&&m.key===worksKey))||!rights.includes(p)))errors.push('Lager-Profilrechte müssen ausdrücklich deklariert sein.');}}if(d?.networkPermissions){const entries=Object.entries(d.networkPermissions);if(!deps.includes('core.network-requests')||entries.length>8||entries.some(([protocol,grants])=>!/^[-a-z0-9]+(?:[.-][-a-z0-9]+)+$/.test(protocol)||!Array.isArray(grants)||grants.some((p:any)=>!['hub.products.read','hub.stock.read','hub.stock.write'].includes(p)||!rights.includes(p))))errors.push('Netzwerk-Lagerrechte benötigen exakte Protokolle, angeforderte Rechte und den Core-Netzwerkanschluss.');}return errors;
}
export function createHubInventoryRegistry(options:{mode?:(moduleKey:string)=>Promise<any>;configure?:(moduleKey:string,input:any)=>Promise<unknown>;markShared?:()=>Promise<void>;confirmReady?:(moduleKey:string,actor:string)=>Promise<unknown>;sourceInstanceId?:()=>Promise<string>}={}){
 let active:{provider:Provider;live:boolean}|null=null;const listeners=new Set<{listener:()=>unknown;live:()=>boolean}>();
 const publish=()=>{for(const e of listeners)queueMicrotask(()=>Promise.resolve().then(()=>listeners.has(e)&&e.live()&&e.listener()).catch(()=>{}));};
 return{stage(key:string,m:any){if(m.key!==key||validateHubInventoryManifest(m).length)fail('HUB_INVENTORY_MANIFEST_INVALID',500);let live=false,disposed=false,owned:{provider:Provider;live:boolean}|null=null;const provider=m.dependsOn?.includes('core.hub-inventory-provider'),declared=new Set(m.metadata?.hubInventory?.operations||[]),subs=new Set<any>();
 const providerRuntime=provider?Object.freeze({contractVersion:VERSION,register(value:Provider){if(live||disposed||owned||value?.contractVersion!==VERSION||typeof value.invoke!=='function')fail('HUB_INVENTORY_PROVIDER_INVALID');owned={provider:Object.freeze({contractVersion:VERSION,invoke:value.invoke.bind(value)}),live:false};},publishInvalidation(){if(live&&!disposed&&owned?.live&&active===owned)publish();}}):undefined;
 const client=m.metadata?.hubInventory?Object.freeze({contractVersion:VERSION,subscribe(listener:()=>unknown){if(disposed||!declared.has('subscribe')||typeof listener!=='function')fail('HUB_OPERATION_DENIED',403);const e={listener,live:()=>live&&!disposed};listeners.add(e);subs.add(e);return()=>{listeners.delete(e);subs.delete(e);};},...Object.fromEntries(operations.filter(x=>x!=='subscribe').map(op=>[op,async(input:unknown={})=>{
 if(!live||disposed)fail('HUB_CALLER_INACTIVE');if(!declared.has(op))fail('HUB_OPERATION_DENIED',403);
 // Recovery can only finish an already prepared, immutable operation of this module.
 const invocationIdentity=hubInvocationIdentity(key,m,op);const recovery=op==='finish'&&!invocationIdentity;
 if(op==='mode'){if(!options.mode)fail('HUB_INVENTORY_CORE_REQUIRED');return options.mode(key);}
 const identity=invocationIdentity;if(!recovery&&!identity)fail('HUB_AUTHENTICATION_REQUIRED',401);
 if(op==='configure'){if(!identity!.permissions.includes(`module.${key.replace('.','-')}.manager`))fail('HUB_PERMISSION_DENIED',403);if(!options.configure)fail('HUB_INVENTORY_CORE_REQUIRED');return options.configure(key,input);}
 const rights=identity?.permissions||[];
 const reservationOnly=!rights.includes('hub.stock.write')&&rights.includes(reservationPermission)&&mayReserve(key,op);
 if(!recovery&&(!rights.includes('hub.products.read')||op==='adopt'&&!rights.includes('hub.products.write')
   ||!rights.includes('hub.stock.read')||!reads.has(op)&&!rights.includes('hub.stock.write')&&!reservationOnly))fail('HUB_PERMISSION_DENIED',403);
 if(reservationOnly&&op==='prepare'){
  const booking=input as {changes?:unknown[];claimScope?:string};
  if(booking?.claimScope!==worksCalendarScope||!Array.isArray(booking.changes)||booking.changes.length)fail('HUB_PERMISSION_DENIED',403);
 }
 if(op==='confirmReady'){if(!options.confirmReady)fail('HUB_INVENTORY_CORE_REQUIRED');return options.confirmReady(key,identity!.accountId);}
 if(['prepare','manage'].includes(op)&&options.mode){const mode=await options.mode(key);if(mode.pendingApps?.length)fail('HUB_STOCK_ADOPTION_REQUIRED',409);}
 const target=active;if(!target?.live)fail('HUB_UNAVAILABLE');let payload;try{const json=JSON.stringify(input);if(Buffer.byteLength(json)>2000000)fail('HUB_INVENTORY_INPUT_INVALID',400);payload=JSON.parse(json);}catch{fail('HUB_INVENTORY_INPUT_INVALID',400);}
 const instance=options.sourceInstanceId?await options.sourceInstanceId():fail('HUB_INSTANCE_IDENTITY_REQUIRED');const context=Object.freeze({sourceModule:key,sourceInstanceId:instance,actorAccountId:identity?.accountId||'CORE_RECOVERY',recovery,reservationOnly,networkOrigin:identity&&'networkOrigin'in identity?identity.networkOrigin:undefined,assertActive(){identity?.assertCurrent();if(!live||disposed||target!==active||!target.live)fail('HUB_CALL_CANCELLED');}});context.assertActive();const result=await target.provider.invoke(op,payload,context);context.assertActive();if(['prepare','adopt','adoptClaims','manage'].includes(op))await options.markShared?.();return structuredClone(result);
 }]))}):undefined;
 return{providerRuntime,client,activate(){if(disposed)fail('HUB_CALLER_INACTIVE');if(provider){if(!owned)fail('HUB_INVENTORY_PROVIDER_INVALID');if(active&&active!==owned)fail('HUB_PROVIDER_ALREADY_ACTIVE',409);owned.live=true;active=owned;}live=true;publish();},dispose(){disposed=true;live=false;for(const e of subs)listeners.delete(e);if(owned)owned.live=false;if(active===owned){active=null;publish();}}};}};
}
export const hubInventoryRegistry=createHubInventoryRegistry({async markShared(){const {markSharedInventory}=await import('./shared-inventory-mode.js');await markSharedInventory();},async confirmReady(key,actor){const {confirmInventorySource}=await import('./shared-inventory-mode.js');return confirmInventorySource(key,actor);},async mode(){const {getSharedInventoryMode}=await import('./shared-inventory-mode.js');return getSharedInventoryMode();},async configure(key,input){const {configureSharedInventoryMode}=await import('./shared-inventory-mode.js');return configureSharedInventoryMode(key,input);},async sourceInstanceId(){const {getPrismaClient}=await import('../database/prisma.js');return getCoreInstanceId(getPrismaClient());}});
