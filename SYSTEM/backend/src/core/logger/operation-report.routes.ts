import { Router } from 'express';
import { getVerifiedRequestIdentity, type RequestIdentity } from '../../platform/auth/request-identity/request-identity-context.js';
import { diagnosticCatalog, diagnosticCode, validDiagnosticId } from './diagnostic-journal.js';
import { isDiagnosticModuleKey } from './diagnostic-context.js';
import { logger } from './logger.js';

const FIELDS=new Set(['moduleId','operationId','phase','workflow','code','statusCode','durationMs','fileSize','appVersion','expectedVersion','browser','userGesture']);
export function createOperationReportRouter({identity=getVerifiedRequestIdentity,record=(level:string,data:any)=>logger.log(level,'MODULE_DIAGNOSTIC_EVENT',data),now=Date.now}:{identity?:()=>RequestIdentity|null;record?:(level:string,data:any)=>unknown;now?:()=>number}={}) {
  const router=Router();const rates=new Map<string,{at:number;count:number}>();
  router.post('/operations',(req,res)=>{
    const actor=identity();
    if(!actor || (req as any).bonniIdentityVerified!==true)return void res.status(401).json({code:'DIAGNOSTIC_ACCESS_DENIED'});
    const data=req.body;
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!FIELDS.has(k))||!isDiagnosticModuleKey(data.moduleId)||!validDiagnosticId(data.operationId)||!Object.hasOwn(diagnosticCatalog.stages,data.phase||'')||!Object.hasOwn(diagnosticCatalog.workflows,data.workflow||''))return void res.status(400).json({code:'DIAGNOSTIC_EVENT_INVALID'});
    if(actor.type!=='ADMIN'&&!actor.allowedApps.includes(data.moduleId))return void res.status(403).json({code:'DIAGNOSTIC_ACCESS_DENIED'});
    for(const [key,max]of [['fileSize',100*1024*1024],['durationMs',86400000],['statusCode',599]] as const){if(data[key]!==undefined&&(!Number.isFinite(data[key])||data[key]<0||data[key]>max))return void res.status(400).json({code:'DIAGNOSTIC_EVENT_INVALID'});}
    const time=now();for(const [key,value]of rates)if(time-value.at>=60000)rates.delete(key);
    let rate=rates.get(actor.accountId);if(!rate){if(rates.size>=2000)return void res.status(429).json({code:'DIAGNOSTIC_RATE_LIMITED'});rate={at:time,count:0};rates.set(actor.accountId,rate);}
    if(++rate.count>600)return void res.status(429).json({code:'DIAGNOSTIC_RATE_LIMITED'});
    const failed=diagnosticCatalog.stages[data.phase][1]==='failed';
    record(failed?'error':'info',{...data,...(data.code?{code:diagnosticCode(data.code)}:failed?{code:'DIAGNOSTIC_UNKNOWN_ERROR'}:{}),source:'browser'});
    res.status(202).json({ok:true});
  });
  return router;
}
export const operationReportRouter=createOperationReportRouter();
