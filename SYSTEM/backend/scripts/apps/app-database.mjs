import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile,sha256,fail,plainDirectory} from './app-package.mjs';

export async function readAppDatabase(appRoot,appId) {
  const data=JSON.parse(await readFile(path.join(appRoot,'APP-DATABASE.json')));
  if(data.schema!=='bonni.app-database/v1'||appId!=='STUEBERLAPP'||data.appId!==appId||data.domain!=='stueberl'
    ||data.prismaVersion!=='6.19.3'||data.client!=='database/client/index.js')fail('APP_DATABASE_PACKAGE_INVALID');
  const sql=await readFile(path.join(appRoot,'database/install.sql'));
  const models=await readFile(path.join(appRoot,'database/models.prisma'));
  if(sha256(sql)!==data.sqlSha256||sha256(models)!==data.modelsSha256)fail('APP_DATABASE_PACKAGE_CHANGED');
  return {...data,sql:sql.toString('utf8')};
}
export async function loadAppClient(appRoot,data) {
  const root=path.join(appRoot,'database/client');await plainDirectory(root);
  const require=createRequire(path.join(root,'index.js'));
  for(const key of Object.keys(require.cache))if(key.startsWith(root+path.sep))delete require.cache[key];
  const client=require('./index.js');
  if(typeof client.PrismaClient!=='function'||client.Prisma?.prismaVersion?.client!==data.prismaVersion
    ||!Array.isArray(client.Prisma?.dmmf?.datamodel?.models))fail('APP_DATABASE_CLIENT_INVALID');
  return client;
}
// Only empty app schemas are initialized. A different existing schema needs
// an explicit migration package; there is no db-push or accept-data-loss path.
export async function prepareAppSchema({client,data}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock($1)',[1729616701]);
    const marker=await client.query("SELECT to_regclass('stueberl._bonni_app_schema') AS name");
    if(marker.rows[0]?.name) {
      const saved=await client.query('SELECT hash FROM stueberl._bonni_app_schema WHERE id = 1');
      if(saved.rows.length!==1||saved.rows[0].hash!==data.modelsSha256)fail('APP_DATABASE_MIGRATION_REQUIRED');
      await client.query('COMMIT');return {initialized:false};
    }
    const occupied=await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='stueberl' LIMIT 1");
    if(occupied.rows.length)fail('APP_DATABASE_MIGRATION_REQUIRED');
    await client.query('CREATE SCHEMA IF NOT EXISTS stueberl');
    await client.query('REVOKE ALL ON SCHEMA stueberl FROM PUBLIC');
    await client.query('SET LOCAL search_path TO stueberl');
    await client.query(data.sql);
    await client.query('CREATE TABLE stueberl._bonni_app_schema (id integer PRIMARY KEY CHECK (id=1), hash text NOT NULL)');
    await client.query('INSERT INTO stueberl._bonni_app_schema (id,hash) VALUES (1,$1)',[data.modelsSha256]);
    await client.query('COMMIT');return {initialized:true};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
}
