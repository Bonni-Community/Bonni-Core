import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateMessage, privateCode, privateValue } from '../../../scripts/runtime/log-privacy.mjs';
import { ensureCoreLogDirectory, resolveCoreLogPaths } from './coreLogStorage.js';
import { getDiagnosticRequest, getDiagnosticRuntime, isDiagnosticModuleKey, isRegisteredDiagnosticModule } from './diagnostic-context.js';

export const diagnosticCatalog = JSON.parse(fs.readFileSync(new URL('../../../scripts/runtime/operation-catalog.json', import.meta.url), 'utf8'));
const codes = new Set<string>(diagnosticCatalog.codes);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VERSION = /^v?\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:\+?[a-z])?(?:[-.+](?:DEV|dev|RC|rc|beta|alpha|UI)[.-]?\d{1,6})?$/;
const LEVELS = new Set(['info','warn','error','critical']);
export const CORE_JOURNAL_FILE = 'bonni-core-journal.jsonl';
export const JOURNAL_RETENTION_MS = 3 * 86400000;
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
export type DiagnosticEntry = {
  schema: string; id: string; timestamp: string; category: string; moduleId: string;
  level: string; source: 'browser'|'server'; code?: string; message?: string;
  operationId?: string; phase?: string; workflow?: string; requestId?: string;
  statusCode?: number; durationMs?: number; fileSize?: number; appVersion?: string;
  expectedVersion?: string; coreVersion?: string; browser?: string; userGesture?: boolean;
};
export function diagnosticModule(value: unknown) {
  if (typeof value !== 'string') return 'core';
  if (Object.hasOwn(diagnosticCatalog.modules,value) || isRegisteredDiagnosticModule(value)) return value;
  const safe = privateValue({module:value});
  return typeof safe?.module === 'string' ? safe.module : 'core';
}
export function diagnosticCategory(moduleId: string) {
  if (Object.hasOwn(diagnosticCatalog.modules, moduleId)) return diagnosticCatalog.modules[moduleId];
  return isDiagnosticModuleKey(moduleId) ? 'applications' : 'system';
}

export function diagnosticApplicationId(moduleId: string): string {
  return Object.hasOwn(diagnosticCatalog.applicationAliases, moduleId)
    ? diagnosticCatalog.applicationAliases[moduleId]
    : moduleId;
}

type JournalFilter = {category?: string; moduleId?: string; limit?: number; all?: boolean};

function matchesCategory(entry: DiagnosticEntry, category: string) {
  if (category === 'all') return true;
  if (category === 'applications') return isDiagnosticModuleKey(entry.moduleId);
  return entry.category === category;
}
export function diagnosticCode(value: unknown) { return typeof value==='string' && (codes.has(value)||privateCode(value)!=='CORE_ERROR') ? value : 'DIAGNOSTIC_UNKNOWN_ERROR'; }
export function validDiagnosticId(value: unknown): value is string { return typeof value==='string' && UUID.test(value); }
function version(value: unknown) { return typeof value==='string' && VERSION.test(value) ? value : undefined; }
function number(value: unknown, maximum: number) { return typeof value==='number' && Number.isFinite(value) && value>=0 && value<=maximum ? Math.round(value) : undefined; }
function project(input: any, timestamp: string, id: string): DiagnosticEntry {
  const moduleId=diagnosticModule(input.moduleId || input.module);
  const phase=typeof input.phase==='string' && Object.hasOwn(diagnosticCatalog.stages,input.phase) ? input.phase : undefined;
  const level=LEVELS.has(input.level) ? input.level : 'info';
  const rawCode=input.code || input.errorCode || (!phase && /^[A-Z][A-Z0-9_]+$/.test(String(input.message||'')) ? input.message : undefined);
  const result: DiagnosticEntry={schema:'bonni.diagnostic-entry/v1',id,timestamp,moduleId,category:diagnosticCategory(moduleId),level,source:input.source==='browser'?'browser':'server'};
  if(rawCode)result.code=diagnosticCode(rawCode);
  if(phase)result.phase=phase;
  else { const message=privateMessage(input.message); if(message!=='[Ausgabe ausgelassen]')result.message=message; }
  if(validDiagnosticId(input.operationId))result.operationId=input.operationId;
  if(validDiagnosticId(input.requestId))result.requestId=input.requestId;
  if(typeof input.workflow==='string'&&Object.hasOwn(diagnosticCatalog.workflows,input.workflow))result.workflow=input.workflow;
  const status=number(input.statusCode,599);if(status!==undefined&&status>=100)result.statusCode=status;
  for(const [key,max] of [['durationMs',86400000],['fileSize',100*1024*1024]] as const){const n=number(input[key],max);if(n!==undefined)result[key]=n;}
  for(const key of ['appVersion','expectedVersion','coreVersion'] as const){const v=version(input[key]);if(v)result[key]=v;}
  if(['Firefox','Chrome','Edge','Safari','Other'].includes(input.browser))result.browser=input.browser;
  if(typeof input.userGesture==='boolean')result.userGesture=input.userGesture;
  return result;
}
export function createDiagnosticJournal({root,now=Date.now,maxBytes=JOURNAL_MAX_BYTES}:{root?:string;now?:()=>number;maxBytes?:number}={}) {
  let lastError:string|null=null;
  const paths=()=>{const p=resolveCoreLogPaths();return root?{...p,root,logFile:path.join(root,'bonni-core.log'),errorFile:path.join(root,'bonni-core-error.txt')}:p;};
  const names=()=>{const file=path.join(paths().root,CORE_JOURNAL_FILE);return [file,file+'.1',file+'.2'];};
  const state=(file:string)=>{try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('DIAGNOSTIC_JOURNAL_UNAVAILABLE');return s;}catch(e:any){if(e.code==='ENOENT')return null;throw e;}};
  function clean(){for(const file of names()){const s=state(file);if(s&&s.mtimeMs<now()-JOURNAL_RETENTION_MS)fs.unlinkSync(file);}}
  return {
    append(input:any) {
      try {
        const entry=project(input,new Date(now()).toISOString(),randomUUID());
        const line=JSON.stringify(entry)+'\n';if(Buffer.byteLength(line)>4096)return false;
        ensureCoreLogDirectory(paths());clean();const [file,first,second]=names();
        const s=state(file);
        if(s&&s.size+Buffer.byteLength(line)>maxBytes){state(first);state(second);if(fs.existsSync(second))fs.unlinkSync(second);if(fs.existsSync(first))fs.renameSync(first,second);fs.renameSync(file,first);}
        const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW||0),0o600);
        try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new Error('DIAGNOSTIC_JOURNAL_UNAVAILABLE');fs.writeFileSync(fd,line,'utf8');}finally{fs.closeSync(fd);}
        lastError=null;return true;
      }catch{lastError='DIAGNOSTIC_JOURNAL_UNAVAILABLE';return false;}
    },
    read({category='all',moduleId,limit=500,all=false}:JournalFilter={}) {
      const entries:DiagnosticEntry[]=[];let available=lastError===null;
      const applicationIds = new Set<string>();
      try{
        clean();const seen=new Set<string>();
        for(const file of names().reverse()){
          const stat=state(file);if(!stat)continue;if(stat.size>maxBytes+4096)throw new Error('DIAGNOSTIC_JOURNAL_UNAVAILABLE');
          const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
          let content:string;
          try {
            const actual=fs.fstatSync(fd);
            if(!actual.isFile()||actual.nlink!==1||actual.size>maxBytes+4096)throw new Error('DIAGNOSTIC_JOURNAL_UNAVAILABLE');
            content=fs.readFileSync(fd,'utf8');
          } finally { fs.closeSync(fd); }
          for(const line of content.split('\n')){
            if(!line||line.length>4096)continue;
            try{const raw=JSON.parse(line);if(raw.schema!=='bonni.diagnostic-entry/v1'||!validDiagnosticId(raw.id)||seen.has(raw.id))continue;
              const time=Date.parse(raw.timestamp);if(!Number.isFinite(time)||time<now()-JOURNAL_RETENTION_MS||time>now()+120000)continue;
              const entry = project(raw, new Date(time).toISOString(), raw.id);
              // After a restart, an unverified package ID must not appear as a Core event.
              if (isDiagnosticModuleKey(raw.moduleId) && raw.moduleId !== entry.moduleId) continue;
              seen.add(raw.id);
              const applicationId = diagnosticApplicationId(entry.moduleId);
              if (category === 'applications' && isDiagnosticModuleKey(applicationId)) applicationIds.add(applicationId);
              if (matchesCategory(entry, category) && (!moduleId || moduleId === entry.moduleId || moduleId === applicationId)) {
                entries.push(entry);
              }
            }catch{/* Ignore damaged or foreign lines, never return raw text. */}
          }
        }
      }catch{available=false;}
      const bounded=Math.min(2000,Math.max(20,Number(limit)||500));
      return {entries:all?entries:entries.slice(-bounded),total:entries.length,truncated:entries.length>bounded,available,file:CORE_JOURNAL_FILE,retentionHours:72,...(category==='applications'?{applicationIds:[...applicationIds].sort()}: {})};
    },
  };
}
const journal=createDiagnosticJournal();
export function recordCoreDiagnostic(input:any) { return journal.append(input); }
export function readCoreDiagnostics(options:JournalFilter={}) { return journal.read(options); }
export function recordLoggerDiagnostic(info:any) {
  const level=String(info.level||'').toLowerCase();if(!LEVELS.has(level))return;
  if(info.module==='http' && ['/logs','/operations'].includes(info.path))return;
  const request=getDiagnosticRequest();
  const runtime=getDiagnosticRuntime();
  const applicationId = [info.module, info.moduleId, request?.moduleId].map(diagnosticModule).find(isDiagnosticModuleKey);
  if (info.source === 'browser' && !applicationId) return;
  const moduleId = applicationId || diagnosticModule(info.moduleId || info.module || request?.moduleId);
  recordCoreDiagnostic({...info,moduleId,operationId:info.operationId||request?.operationId,coreVersion:runtime.coreVersion});
}
