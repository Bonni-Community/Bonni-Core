import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {Prisma} from '@prisma/client';
import pg from 'pg';
import {registerAppDatabaseClient,normalizePrismaConnectionString} from '../../../core/database/prisma.js';
import {getDataDomainConnectionString} from '../../../core/database/data-domain-routing.js';
import {getDatabaseWriteOrder,getDatabaseTargetConnectionString} from '../../../core/database/database-routing.js';
import {getActiveDatabaseRole} from '../../../core/database/database-context.js';
import {env} from '../../../core/config/env.js';
const backendRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const loaded=new Map<string,string>();
async function helper() {return import(pathToFileURL(path.join(backendRoot,'scripts/apps/app-database.mjs')).href);}
export async function prepareInstalledAppDatabase(appRoot:string,appId:string,delegates:string[]) {
  const h=await helper(),data=await h.readAppDatabase(appRoot,appId);
  if(data.prismaVersion!==Prisma.prismaVersion.client)throw new Error('APP_DATABASE_CORE_VERSION_MISMATCH');
  const generated=await h.loadAppClient(appRoot,data);
  const models=new Set(generated.Prisma.dmmf.datamodel.models.map((m:any)=>m.name[0].toLowerCase()+m.name.slice(1)));
  if(!delegates.length||delegates.some(d=>!models.has(d)))throw new Error('APP_DATABASE_DELEGATES_MISSING');
  const urls=getActiveDatabaseRole()==='local'
    ?[getDataDomainConnectionString('stueberl','local',env.LOCAL_DATABASE_URL||'')]
    :getDatabaseWriteOrder().map(target=>getDataDomainConnectionString('stueberl',target,getDatabaseTargetConnectionString(target)));
  for(const url of new Set(urls)) {
    const client=new pg.Client({connectionString:normalizePrismaConnectionString(url),connectionTimeoutMillis:15000});
    try {await client.connect();await h.prepareAppSchema({client,data});}finally{await client.end();}
  }
  return data;
}
export async function ensureAppDatabaseRuntime(appRoot:string,key:string,force=false) {
  if(key!=='app.stueberlapp'||!existsSync(path.join(appRoot,'APP-DATABASE.json')))return;
  const h=await helper(),data=await h.readAppDatabase(appRoot,'STUEBERLAPP');
  if(!force&&loaded.get(key)===data.modelsSha256)return;
  if(data.prismaVersion!==Prisma.prismaVersion.client)throw new Error('APP_DATABASE_CORE_VERSION_MISMATCH');
  const client=await h.loadAppClient(appRoot,data);
  await registerAppDatabaseClient('stueberl',client.PrismaClient,client.Prisma.dmmf.datamodel.models);
  loaded.set(key,data.modelsSha256);
}
export async function forgetAppDatabaseRuntime(key:string) {
  if(key==='app.stueberlapp'){loaded.delete(key);await registerAppDatabaseClient('stueberl',null,[]);}
}
