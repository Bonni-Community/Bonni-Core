import catalog from '../../../backend/scripts/runtime/operation-catalog.json' with {type:'json'};
import { buildApiUrls } from '../api/apiConfig.js';
export const MODULE_DIAGNOSTIC_MESSAGE='bonni:module-diagnostic';
export const MODULE_DIAGNOSTIC_CAPABILITY=Object.freeze({version:1});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VERSION=/^v?\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:\+?[a-z])?(?:[-.+](?:DEV|dev|RC|rc|beta|alpha|UI)[.-]?\d{1,6})?$/;
const codes=new Set(catalog.codes);
export const validOperationId=value=>typeof value==='string'&&UUID.test(value);
function browserFamily(value='') {return /Firefox\//.test(value)?'Firefox':/Edg\//.test(value)?'Edge':/(?:Chrome|Chromium)\//.test(value)?'Chrome':/Safari\//.test(value)?'Safari':'Other';}
export function safeModuleDiagnostic(event,{moduleId,moduleVersion,browser='Other'}={}) {
 if(!event||!validOperationId(event.operationId)||!Object.hasOwn(catalog.stages,event.phase||'')||!Object.hasOwn(catalog.workflows,event.workflow||''))return null;
 const result={moduleId,operationId:event.operationId,phase:event.phase,workflow:event.workflow,browser};
 if(event.code)result.code=(codes.has(event.code)||/^P\d{4}$/.test(event.code)||/^(?:\d{2}|XX|HV|P0|F0)[A-Z0-9]{3}$/.test(event.code))?event.code:'DIAGNOSTIC_UNKNOWN_ERROR';
 for(const key of ['appVersion','expectedVersion']){const value=key==='expectedVersion'?moduleVersion:event[key];if(typeof value==='string'&&VERSION.test(value))result[key]=value;}
 for(const [key,max]of [['fileSize',100*1024*1024],['durationMs',86400000],['statusCode',599]]){if(Number.isFinite(event[key])&&event[key]>=0&&event[key]<=max)result[key]=Math.round(event[key]);}
 if(typeof event.userGesture==='boolean')result.userGesture=event.userGesture;
 return result;
}
export function createModuleDiagnosticReporter({moduleId,moduleVersion,getContext,fetcher=globalThis.fetch?.bind(globalThis),userAgent=globalThis.navigator?.userAgent||''}={}) {
 let destroyed=false,running=false;const queue=[],controllers=new Set();const seen=new Set();
 async function drain(){if(running||destroyed)return;running=true;
  try{while(queue.length&&!destroyed){const job=queue.shift(),context=getContext?.();if(!context?.token||(context.user?.accountId||context.user?.id)!==job.accountId||context.token!==job.token)continue;
   const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),2500);
   try{await fetcher(buildApiUrls('/api/debug/operations')[0],{method:'POST',credentials:'omit',headers:{Authorization:`Bearer ${context.token}`,'Content-Type':'application/json'},body:JSON.stringify(job.event),signal:controller.signal});}catch{/* A diagnostic write cannot fail an app request. */}finally{clearTimeout(timer);controllers.delete(controller);}
  }}finally{running=false;}
 }
 function report(raw){if(destroyed||!fetcher)return false;const context=getContext?.();if(!context?.token)return false;
  const event=safeModuleDiagnostic(raw,{moduleId,moduleVersion,browser:browserFamily(userAgent)});if(!event)return false;
  const key=JSON.stringify([event.operationId,event.phase,event.workflow,event.code,event.statusCode]);if(seen.has(key)||queue.length>=128)return false;
  seen.add(key);if(seen.size>1000)seen.delete(seen.values().next().value);
  queue.push({event,accountId:context.user?.accountId||context.user?.id,token:context.token});void drain();return true;
 }
 return {report,
  start(request){const media=/\/image(?:\?|$)/.test(request.path||'');const tracked=media||validOperationId(request.diagnosticOperationId);const operationId=validOperationId(request.diagnosticOperationId)?request.diagnosticOperationId:globalThis.crypto?.randomUUID?.();const workflow=media?(request.method==='GET'?'media-read':'media-upload'):'app-request';const started=Date.now();if(tracked)report({operationId,workflow,phase:'request-started'});return {operationId,workflow,tracked,started};},
  finish(trace,result,cancelled=false){if(!trace?.operationId)return;if(trace.tracked||!result.ok)report({operationId:trace.operationId,workflow:trace.workflow,phase:cancelled?'request-cancelled':result.ok?'request-succeeded':'request-failed',...(!result.ok&&!cancelled?{code:result.payload?.code||result.payload?.error?.code||result.payload?.error||'DIAGNOSTIC_UNKNOWN_ERROR'}:{}),statusCode:result.status,durationMs:Date.now()-trace.started});},
  destroy(){destroyed=true;queue.length=0;for(const controller of controllers)controller.abort();controllers.clear();},
 };
}
