import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {getVerifiedRequestIdentity,runWithVerifiedRequestIdentity} from '../../platform/auth/request-identity/request-identity-context.js';

type Invocation=Readonly<{moduleKey:string;protocol:string;requestId:string;peer:Readonly<{sourceOrganizationId:string;sourceBonniSerial:string;serviceAccountId:string}>;remoteActorAccountId:string|null;signal:AbortSignal}>;
const invocations=new AsyncLocalStorage<Invocation>();

/** Core calls this only after its transport, peer, recipient and module policy checks. */
export function runWithVerifiedNetworkInvocation<T>(input:Invocation,work:()=>T):T {
 const value=Object.freeze({...input,peer:Object.freeze({...input.peer})});
 return invocations.run(value,()=>runWithVerifiedRequestIdentity(null,work));
}

/** A network invocation never impersonates a local member or grants setup rights. */
export function hubInvocationIdentity(moduleKey:string,manifest:any,operation:string){
 const human=getVerifiedRequestIdentity();
 if(human)return {...human,assertCurrent(){}};
 const invocation=invocations.getStore();
 if(!invocation||invocation.moduleKey!==moduleKey||!['get','list','getStockItem','listStockItems','snapshot','prepare','finish'].includes(operation))return null;
 const grants=manifest.metadata?.hubInventory?.networkPermissions?.[invocation.protocol];
 if(!Array.isArray(grants))return null;
 const actorHash=createHash('sha256').update(JSON.stringify([invocation.peer,invocation.remoteActorAccountId])).digest('hex');
 return {accountId:`CORE_NETWORK:${actorHash}`,permissions:grants,networkOrigin:{...invocation.peer,remoteActorAccountId:invocation.remoteActorAccountId,requestId:invocation.requestId},assertCurrent(){if(invocation.signal.aborted)throw Object.assign(new Error('HUB_CALL_CANCELLED'),{code:'HUB_CALL_CANCELLED',statusCode:503});}};
}
