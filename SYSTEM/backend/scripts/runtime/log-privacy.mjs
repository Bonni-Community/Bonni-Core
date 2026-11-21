import {readFileSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
const policy=JSON.parse(readFileSync(new URL('./log-privacy-policy.json',import.meta.url),'utf8'));
const codes=new Set(policy.codes),messages=new Set(policy.messages),identifiers=new Set(policy.identifiers),files=new Set(policy.files),modules=new Set(policy.modules),types=new Set(policy.types);
export const OMITTED='[Ausgabe ausgelassen]';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const nativeStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;
export function privateCode(value){const s=String(value||'');return codes.has(s)||/^P\d{4}$/.test(s)||/^(?:\d{2}|XX|HV|P0|F0)[A-Z0-9]{3}$/.test(s)?s:'CORE_ERROR';}
export function privateMessage(value){
 const s=String(value??'').trim();
 if(messages.has(s))return s;
 if(/^Prisma P\d{4}$/.test(s))return s;
 const sql=/^PostgreSQL ((?:\d{2}|XX|HV|P0|F0)[A-Z0-9]{3})(?:\b|$)/.exec(s);if(sql)return `PostgreSQL ${sql[1]}`;
 const match=/^([A-Z][A-Z0-9_]+)(?::(.*))?$/.exec(s);
 if(match&&codes.has(match[1])){
  const names=(match[2]||'').split(/[,\s]+/).filter(Boolean).filter(item=>item.split('.').every(part=>identifiers.has(part)));
  return match[1]+(names.length?':'+names.join(', '):'');
 }
 return OMITTED;
}
export function privateStack(value){
 return String(value||'').split(/\r?\n/).filter(line=>/^\s*at\s/.test(line)).slice(0,40).map(line=>{
  const m=/([^/\\():\s]+):([0-9]+):([0-9]+)\)?\s*$/.exec(line);
  return m&&files.has(m[1])?` at ${m[1]}:${m[2]}:${m[3]}`:' at [Position ausgelassen]';
 }).join('\n');
}
function scalar(value,kind){
 if(value===null)return null;
 if(kind==='number')return typeof value==='number'&&Number.isFinite(value)?value:undefined;
 if(kind==='boolean')return typeof value==='boolean'?value:undefined;
 if(typeof value!=='string')return undefined;
 const s=value.trim();
 if(kind==='message')return privateMessage(s);
 if(kind==='stack')return privateStack(s);
 if(kind==='code')return privateCode(s);
 if(kind==='name')return s.split('.').every(x=>identifiers.has(x))?s:'[Bezeichner ausgelassen]';
 if(kind==='version')return /^v?\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:\+?[a-z])?(?:[-.+](?:DEV|dev|RC|rc|beta|alpha|UI)[.-]?\d{1,6})?$/.test(s)?s:undefined;
 if(kind==='id')return uuid.test(s)?s:undefined;
 if(kind==='hash')return /^[a-f0-9]{64}$/.test(s)?s:undefined;
 if(kind==='module')return modules.has(s)?s:undefined;
 if(kind==='phase')return policy.phases.includes(s)?s:undefined;
 if(kind==='time')return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s)?s:undefined;
 if(kind==='migration'){
  const migration=/^\d{8}-([a-z][a-z0-9]{0,31})-runtime-v[1-9][0-9]*$/.exec(s);
  return migration&&identifiers.has(migration[1])?s:undefined;
 }
 if(kind==='schema')return policy.schemas.includes(s)||identifiers.has(s)?s:undefined;
 if(kind==='type')return types.has(s)?s:undefined;
 if(kind==='platform')return ['linux','win32','darwin','x64','arm64','arm','ia32'].includes(s)?s:undefined;
 if(kind==='path'){
  if(policy.routes.includes(s))return s;
  const name=s.replaceAll('\\','/').split('/').pop();return files.has(name)?name:'[Pfad ausgelassen]';
 }
 return undefined;
}
export function privateValue(value,key='',seen=new WeakSet(),depth=0){
 if(depth>12)return '[Tiefe begrenzt]';
 if(typeof value==='string'&&!key){
  if(value.length<=1024*1024&&/^\s*[\[{]/.test(value)){try{return JSON.stringify(privateValue(JSON.parse(value),'',seen,depth+1));}catch{}}
  return privateMessage(value);
 }
 const kind=policy.fields[key];
 if(key&& !kind)return undefined;
 if(kind==='names')return Array.isArray(value)?value.slice(0,256).map(v=>scalar(v,'name')):undefined;
 if(kind&&!['object','array'].includes(kind))return scalar(value,kind);
 if(value===null)return null;
 if(typeof value!=='object')return undefined;
 if(seen.has(value))return '[Zyklus]';seen.add(value);
 try{
  if(value instanceof Error){
   const properties=Object.getOwnPropertyDescriptors(value);
   const read=(key)=>properties[key]&&'value'in properties[key]?properties[key].value:undefined;
   const code=privateCode(read('code'));
   const stack=typeof read('stack')==='string'?read('stack'):(()=>{try{return nativeStackGetter&&properties.stack?.get===nativeStackGetter?nativeStackGetter.call(value):'';}catch{return '';}})();
   const record={name:read('name')||'Error',message:code==='CORE_ERROR'?privateMessage(read('message')):(/^[P0-9]/.test(code)?`${/^P\d{4}$/.test(code)?'Prisma':'PostgreSQL'} ${code}`:code),stack};
   for(const k of ['code','cause','errors','meta','diagnostic','schemaIssues','table','column','schema','constraint','clientVersion'])if(properties[k]&&'value'in properties[k])record[k]=read(k);
   return privateValue(record,'',seen,depth+1);
  }
  if(Array.isArray(value))return value.slice(0,256).map(v=>privateValue(v,'',seen,depth+1)).filter(v=>v!==undefined);
  const result={};
  for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0,128)){
   if(!('value'in d)||!policy.fields[k])continue;
   const next=privateValue(d.value,k,seen,depth+1);if(next!==undefined)result[k]=next;
  }return result;
 }finally{seen.delete(value);}
}
export function privateLine(value){
 const s=String(value||'');
 if(/^= \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s))return s;
 if(/^—{3,}-?$/.test(s))return '——————————————-';
 const after=/^\[NACHLAUF:([a-f0-9-]{36})\] (.*)$/.exec(s);if(after)return `[NACHLAUF:${after[1]}] ${privateLine(after[2])}`;
 const id=/^\[DIAGNOSE-ID\] ([a-f0-9-]{36})$/.exec(s);if(id)return s;
 const marker=/^\[(CRITICAL )?ERROR\] ([A-Z0-9_]+)$/.exec(s);if(marker)return `[${marker[1]||''}ERROR] ${privateCode(marker[2])}`;
 let pos=s.lastIndexOf(' {');
 for(let tries=0;pos>=0&&tries<32;tries++,pos=s.lastIndexOf(' {',pos-1)){
  try{
   const data=privateValue(JSON.parse(s.slice(pos+1)));
   const head=s.slice(0,pos);const time=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\b/.exec(head)?.[0]||'';
   const level=/\b(CRITICAL|ERROR|WARN|INFO|DEBUG)\b/.exec(head)?.[0]||'INFO';
   const label=privateMessage(head.replace(/^\d{4}-\d\d-\d\dT\S+\s+\S+\s*/,'').replace(/^(?:\[[^\]]*\])+/,'').trim());
   return `${time} ${level} ${label} ${JSON.stringify(data)}`.trim();
  }catch{}
 }
 if(/^\s*[\[{]/.test(s)){try{return JSON.stringify(privateValue(JSON.parse(s)));}catch{}}
 if(/^\s*at\s/.test(s))return privateStack(s);
 const message=privateMessage(s);if(message!==OMITTED)return message;
 const code=s.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.find(x=>codes.has(x));
 return code||OMITTED;
}
export function privateText(value){return String(value||'').split(/\r?\n/).map(privateLine).join('\n');}
export function createPrivateLineWriter(write){
 const decoder=new StringDecoder('utf8');let pending='',overflow=false;
 function feed(text){for(const char of text){if(char==='\n'){write(privateLine(overflow?'':pending)+'\n');pending='';overflow=false;}else if(!overflow){pending+=char;if(pending.length>512*1024){pending='';overflow=true;}}}}
 return {write(chunk){feed(typeof chunk==='string'?chunk:decoder.write(chunk));},end(){feed(decoder.end());if(pending||overflow)write(privateLine(overflow?'':pending)+'\n');pending='';}};
}
