import { randomUUID } from 'node:crypto';
import { getDiagnosticRequest, getDiagnosticRuntime } from './diagnostic-context.js';
import { diagnosticCode, recordCoreDiagnostic, validDiagnosticId } from './diagnostic-journal.js';

/** Diagnostics never change the result or ownership rules of a media operation. */
export async function withMediaDiagnostic<T extends {sizeBytes?:number}>(moduleId:string,action:'create'|'read',work:()=>Promise<T>):Promise<T>{
 const context=getDiagnosticRequest();
 const operationId=validDiagnosticId(context?.operationId)?context.operationId:randomUUID();
 const started=Date.now();const workflow=action==='create'?'media-upload':'media-read';
 const emit=(phase:string,extra:any={})=>{try{recordCoreDiagnostic({moduleId,operationId,workflow,phase,level:phase==='media-error'?'error':'info',source:'server',requestId:context?.requestId,coreVersion:getDiagnosticRuntime().coreVersion,...extra});}catch{/* Observability must not break media. */}};
 emit(action==='create'?'media-create-started':'media-read-started');
 try{const result=await work();emit(action==='create'?'media-stored':'media-read',{fileSize:result.sizeBytes,durationMs:Date.now()-started});return result;}
 catch(error:any){emit('media-error',{code:diagnosticCode(error?.code||error?.message),durationMs:Date.now()-started});throw error;}
}
