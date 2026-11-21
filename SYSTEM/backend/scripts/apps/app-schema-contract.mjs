import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const upgradeSchema='bonni.app-schema-upgrade/v1';
export const quote=value=>'"'+value.replaceAll('"','""')+'"';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const fail=(code,detail,issues)=>{const error=Object.assign(new Error(code+(detail?':'+detail:'')),{code});if(issues)error.schemaIssues=issues;throw error;};
export function appSchemaUpgradeConnection(runtimeUrl,maintenanceUrl,domain) {
 const runtime=new URL(runtimeUrl),admin=new URL(maintenanceUrl);
 const postgres=url=>['postgres:','postgresql:'].includes(url.protocol);
 if(!identifier(domain)||!postgres(runtime)||!postgres(admin)||runtime.searchParams.get('schema')!==domain)fail('APP_SCHEMA_DATABASE_URL_INVALID');
 const sameCluster=runtime.hostname===admin.hostname&&(runtime.port||'5432')===(admin.port||'5432');
 if(!sameCluster||![admin.pathname,admin.pathname+'_redundant'].includes(runtime.pathname))return runtimeUrl;
 admin.pathname=runtime.pathname;admin.searchParams.set('schema',domain);return admin.toString();
}
const identifier=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
const fingerprint=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const list=text=>{
 if(typeof text!=='string'||!/^"[A-Za-z_][A-Za-z0-9_]*"(?:,\s*"[A-Za-z_][A-Za-z0-9_]*")*$/.test(text))fail('APP_SCHEMA_CONTRACT_INVALID');
 return [...text.matchAll(/"([^"]+)"/g)].map(match=>match[1]);
};
const unique=items=>new Set(items).size===items.length;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function checkedArray(items,max=2048){if(!Array.isArray(items)||items.length>max)fail('APP_SCHEMA_CONTRACT_INVALID');return items;}
function namedMap(items){checkedArray(items);if(items.some(x=>!x||!identifier(x.name))||!unique(items.map(x=>x.name)))fail('APP_SCHEMA_CONTRACT_INVALID');return new Map(items.map(x=>[x.name,x]));}

// Only a small declarative DDL language is accepted. No app executable, raw SQL
// callback, connection URL or privileged database client crosses this contract.
export function validateSchemaPlan(plan,contract,context) {
 const planFields=['schema','moduleKey','domain','id','lockId','source','contract','anchors','bootstrap','emptyForeignKeyTransitions','obsoleteIndexes'];
 if(!plan||!contract||Object.keys(plan).some(k=>!planFields.includes(k))||Object.keys(contract).some(k=>!['version','domain','enums','tables','indexes','constraints'].includes(k)))fail('APP_SCHEMA_CONTRACT_INVALID');
 if(plan.schema!==upgradeSchema||plan.moduleKey!==context.moduleKey||plan.domain!==context.domain||contract.domain!==context.domain
  ||!(/^app\.[a-z][a-z0-9-]{0,63}$/.test(context.moduleKey)||['gourmet','capture','paypal'].includes(context.domain)&&context.moduleKey==='addon.'+context.domain)||!identifier(context.domain)
  ||['gourmet','capture','paypal'].includes(context.domain)&&context.moduleKey!=='addon.'+context.domain
  ||['core','people','privacy','organization','public','pg_catalog','information_schema'].includes(context.domain)
  ||contract.version!==1||!/^\d{8}-[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$/.test(plan.id)
  ||!Number.isInteger(plan.lockId)||plan.lockId<1||plan.lockId>2147483647)fail('APP_SCHEMA_CONTRACT_INVALID');
 const enums=namedMap(contract.enums),tables=namedMap(contract.tables),indexes=namedMap(contract.indexes),keys=namedMap(contract.constraints);
 if(tables.has('_BonniRuntimeMigration')||tables.has('_bonni_app_schema'))fail('APP_SCHEMA_CONTRACT_INVALID');
 for(const item of enums.values()) {
  checkedArray(item.values,512);
  if(!item.values.length||!unique(item.values)||item.values.some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,63}$/.test(v)))fail('APP_SCHEMA_CONTRACT_INVALID');
  if(item.create!==`CREATE TYPE ${quote(item.name)} AS ENUM (${item.values.map(literal).join(', ')});`)fail('APP_SCHEMA_SQL_NOT_ISOLATED');
 }
 for(const item of tables.values()) {
  checkedArray(item.columns,1024);if(!item.columns.length||!unique(item.columns.map(x=>x.name)))fail('APP_SCHEMA_CONTRACT_INVALID');
  for(const c of item.columns) {
   if(!identifier(c.name)||typeof c.required!=='boolean')fail('APP_SCHEMA_CONTRACT_INVALID');
   const type=/^(TEXT|INTEGER|BOOLEAN|JSONB|DOUBLE PRECISION|TIMESTAMP\(3\)|DECIMAL\((?:[1-9][0-9]?),[0-9]+\)|"[A-Za-z_][A-Za-z0-9_]*")(?= |$)/.exec(c.definition||'')?.[0];
   if(!type)fail('APP_SCHEMA_SQL_NOT_ISOLATED');
   const expectedType=type.startsWith('"')?type:type==='TIMESTAMP(3)'?'timestamp(3) without time zone':type.replace('DECIMAL','numeric').toLowerCase();
   if(type.startsWith('"')&&!enums.has(type.slice(1,-1)))fail('APP_SCHEMA_CONTRACT_INVALID');
   if(c.type!==expectedType)fail('APP_SCHEMA_CONTRACT_INVALID');
   const suffix=c.definition.slice(type.length),required=c.required?' NOT NULL':'';
   if(!suffix.startsWith(required))fail('APP_SCHEMA_CONTRACT_INVALID');
   const rest=suffix.slice(required.length);
   if(rest&&!/^ DEFAULT (?:-?[0-9]+(?:\.[0-9]+)?|true|false|CURRENT_TIMESTAMP|'(?:[^'\x00-\x1f]|'')*')$/.test(rest))fail('APP_SCHEMA_SQL_NOT_ISOLATED');
  }
  const primary=/^PRIMARY KEY \((.+)\)$/.exec(item.primaryKey||'');
  if(!primary)fail('APP_SCHEMA_CONTRACT_INVALID');
  const pk=primary[1].split(', ').map(x=>x.startsWith('"')?x.slice(1,-1):x);
  if(pk.some(x=>!identifier(x)||!item.columns.some(c=>c.name===x))||!unique(pk))fail('APP_SCHEMA_CONTRACT_INVALID');
  const create=`CREATE TABLE ${quote(item.name)} (\n${item.columns.map(c=>'    '+quote(c.name)+' '+c.definition+',').join('\n')}\n\n    CONSTRAINT ${quote(item.name+'_pkey')} PRIMARY KEY (${pk.map(quote).join(',')})\n);`;
  if(item.create!==create)fail('APP_SCHEMA_SQL_NOT_ISOLATED');
 }
 for(const item of indexes.values()) {
  const parsed=/^CREATE (UNIQUE )?INDEX "([A-Za-z_][A-Za-z0-9_]*)" ON "([A-Za-z_][A-Za-z0-9_]*)"\(([^)]+)\);$/.exec(item.create||'');
  if(!parsed||parsed[2]!==item.name||parsed[3]!==item.table||!tables.has(item.table))fail('APP_SCHEMA_SQL_NOT_ISOLATED');
  if(list(parsed[4]).some(c=>!tables.get(item.table).columns.some(x=>x.name===c)))fail('APP_SCHEMA_CONTRACT_INVALID');
  if(typeof item.definition!=='string'||!item.definition.startsWith(`CREATE ${parsed[1]||''}INDEX ${quote(item.name)} ON ${context.domain}.`))fail('APP_SCHEMA_CONTRACT_INVALID');
 }
 for(const item of keys.values()) {
  const parsed=/^ALTER TABLE "([A-Za-z_][A-Za-z0-9_]*)" ADD CONSTRAINT "([A-Za-z_][A-Za-z0-9_]*)" FOREIGN KEY \(([^)]+)\) REFERENCES "([A-Za-z_][A-Za-z0-9_]*)"\(([^)]+)\) ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT) ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT);$/.exec(item.create||'');
  if(!parsed||parsed[1]!==item.table||parsed[2]!==item.name||!tables.has(item.table)||!tables.has(parsed[4]))fail('APP_SCHEMA_SQL_NOT_ISOLATED');
  const local=list(parsed[3]),target=list(parsed[5]);
  if(local.length!==target.length||local.some(c=>!tables.get(item.table).columns.some(x=>x.name===c))||target.some(c=>!tables.get(parsed[4]).columns.some(x=>x.name===c)))fail('APP_SCHEMA_CONTRACT_INVALID');
 }
 if(!checkedArray(plan.anchors).length||plan.anchors.some(x=>!tables.has(x))||!unique(plan.anchors))fail('APP_SCHEMA_CONTRACT_INVALID');
 if(plan.bootstrap!==undefined&&plan.bootstrap!=='empty-schema')fail('APP_SCHEMA_CONTRACT_INVALID');
 for(const item of checkedArray(plan.emptyForeignKeyTransitions)) {
  const key=keys.get(item.name);
  if(!key||item.table!==key.table||!identifier(item.fromTable)||tables.has(item.fromTable)||!tables.has(item.toTable)
   ||!same(item.fromColumns,['id'])||!same(item.toColumns,['id'])||!Array.isArray(item.columns)||item.columns.length!==1
   ||!tables.get(item.table).columns.some(c=>c.name===item.columns[0])
   ||!key.create.includes(`FOREIGN KEY (${item.columns.map(quote).join(', ')}) REFERENCES ${quote(item.toTable)}(${item.toColumns.map(quote).join(', ')})`))fail('APP_SCHEMA_CONTRACT_INVALID');
 }
 if(!unique(plan.emptyForeignKeyTransitions.map(x=>x.name)))fail('APP_SCHEMA_CONTRACT_INVALID');
 for(const item of checkedArray(plan.obsoleteIndexes)) {
  if(!identifier(item.name)||indexes.has(item.name)||!tables.has(item.table)||!indexes.has(item.replacement)||indexes.get(item.replacement).table!==item.table
   ||typeof item.definition!=='string'||!item.definition.startsWith(`CREATE UNIQUE INDEX ${quote(item.name)} ON ${context.domain}.${quote(item.table)} USING btree (`)
   ||!indexes.get(item.replacement).create.startsWith('CREATE UNIQUE INDEX '))fail('APP_SCHEMA_CONTRACT_INVALID');
 }
 return contract;
}

async function boundPath(root,relative,{directory=false,maxBytes=4*1024*1024}={}) {
 if(typeof relative!=='string'||relative.length>240||!/^[A-Za-z0-9_./-]+$/.test(relative)||relative.split('/').some(x=>!x||x==='.'||x==='..'))fail('APP_SCHEMA_PACKAGE_INVALID');
 const segments=relative.split('/');let current=path.resolve(root);
 const rootState=await fs.lstat(current).catch(()=>fail('APP_SCHEMA_PACKAGE_INVALID'));if(!rootState.isDirectory()||rootState.isSymbolicLink())fail('APP_SCHEMA_PACKAGE_INVALID');
 for(let i=0;i<segments.length;i++) {
  current=path.join(current,segments[i]);const state=await fs.lstat(current).catch(()=>fail('APP_SCHEMA_PACKAGE_INVALID'));
  if(state.isSymbolicLink()||state.nlink>1&&state.isFile()||i<segments.length-1&&!state.isDirectory())fail('APP_SCHEMA_PACKAGE_INVALID');
  if(i===segments.length-1&&(directory?!state.isDirectory():!state.isFile()||state.size>maxBytes))fail('APP_SCHEMA_PACKAGE_INVALID');
 }
 return current;
}
export async function readAppSchemaUpgrade(appRoot,moduleKey,database) {
 const declaration=database?.schemaUpgrade;if(!declaration)return null;
 if(database.mode!=='scoped-v1'||declaration.schema!==upgradeSchema||!fingerprint(declaration.sha256))fail('APP_SCHEMA_CONTRACT_INVALID');
 const bytes=await fs.readFile(await boundPath(appRoot,declaration.file));
 if(digest(bytes)!==declaration.sha256)fail('APP_SCHEMA_PACKAGE_CHANGED');
 let plan;try{plan=JSON.parse(bytes);}catch{fail('APP_SCHEMA_PACKAGE_INVALID');}
 if(plan.schema!==upgradeSchema||plan.moduleKey!==moduleKey||plan.domain!==database.domain||!fingerprint(plan.contract?.sha256)||!fingerprint(plan.source?.sha256))fail('APP_SCHEMA_CONTRACT_INVALID');
 const contractBytes=await fs.readFile(await boundPath(appRoot,plan.contract.file));
 if(digest(contractBytes)!==plan.contract.sha256)fail('APP_SCHEMA_PACKAGE_CHANGED');
 let contract;try{contract=JSON.parse(contractBytes);}catch{fail('APP_SCHEMA_PACKAGE_INVALID');}
 validateSchemaPlan(plan,contract,{moduleKey,domain:database.domain});
 const directory=await boundPath(appRoot,plan.source.directory,{directory:true}),sources=[];let total=0;
 async function visit(root) {
  for(const entry of await fs.readdir(root,{withFileTypes:true})) {
   if(entry.isSymbolicLink())fail('APP_SCHEMA_SOURCE_INVALID');
   const file=path.join(root,entry.name);
   if(entry.isDirectory())await visit(file);
   else if(entry.isFile()&&entry.name.endsWith('.prisma')) {
    const stat=await fs.lstat(file);total+=stat.size;
    if(total>16*1024*1024||stat.nlink>1||sources.length>=2048)fail('APP_SCHEMA_SOURCE_INVALID');
    sources.push([path.relative(directory,file).replaceAll(path.sep,'/'),await fs.readFile(file,'utf8')]);
   }
  }
 }
 await visit(directory);sources.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 if(!sources.length||digest(JSON.stringify(sources))!==plan.source.sha256)fail('APP_SCHEMA_SOURCE_CHANGED');
 return {id:plan.id,sha256:digest(bytes),contract,plan};
}
