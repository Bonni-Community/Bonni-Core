import {assertAppForeignKeyPlan,applyAppForeignKeys} from './app-foreign-keys.mjs';
import {fail,quote,validateSchemaPlan} from './app-schema-contract.mjs';
const literal=value=>"E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";

async function prepareEmptySchema(client, migration) {
  const {contract,plan}=migration,domain=contract.domain;
  if(plan.bootstrap!=='empty-schema') fail('APP_SCHEMA_EXISTING_DATABASE_REQUIRED',migration.id);
  // Existing objects, including enum-only/partial installations, are never
  // interpreted as a fresh app. All reads below inspect catalog metadata only.
  const state=await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
    OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)
    AS occupied`,[domain]);
  if(state.rows[0]?.occupied) fail('APP_SCHEMA_PARTIAL_DATABASE_REQUIRES_MIGRATION',migration.id);
  const legacy=(await client.query(`SELECT c.relname AS "table" FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,[plan.anchors])).rows;
  if(legacy.length) fail('APP_SCHEMA_LEGACY_DATABASE_REQUIRES_MIGRATION',migration.id,
    legacy.map(item=>({table:item.table,expected:{targetSchema:domain},actual:{targetSchema:'public'}})));
  await client.query('CREATE SCHEMA IF NOT EXISTS '+quote(domain));
  await client.query('REVOKE ALL ON SCHEMA '+quote(domain)+' FROM PUBLIC');
  const owner=domain+'_owner',runtime=domain+'_user';
  const roles=(await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rows.map(row=>row.rolname);
  if(roles.includes(owner))await client.query('ALTER SCHEMA '+quote(domain)+' OWNER TO '+quote(owner));
  if(roles.includes(runtime))await client.query('GRANT USAGE ON SCHEMA '+quote(domain)+' TO '+quote(runtime));
}
async function checkExistingRuntimeColumns(client, contract) {
  const rows=(await client.query(`SELECT c.relname AS table_name,c.relkind,
    a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required,
    EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname=$2 AND c.relname=ANY($1::text[])`,[contract.tables.map(table=>table.name),contract.domain])).rows;
  const existing=new Map();
  for(const row of rows) {
    if(row.relkind!=='r'||row.inherited) fail('APP_SCHEMA_TABLE_KIND_INVALID',row.table_name);
    if(!existing.has(row.table_name)) existing.set(row.table_name,new Map());
    existing.get(row.table_name).set(row.column_name,row);
  }
  const incompatible=[];
  for(const table of contract.tables) {
    for(const column of table.columns) {
      const row=existing.get(table.name)?.get(column.name);
      // Missing structures are added below. Report all incompatible existing
      // columns together before any enum labels are committed or DDL is run.
      if(row&&(row.type!==column.type||row.required!==column.required)) {
        incompatible.push({table:table.name,column:column.name,status:'different-column',expected:{type:column.type,required:column.required},actual:{type:row.type,required:row.required}});
      }
    }
  }
  if(incompatible.length) fail('APP_SCHEMA_COLUMN_MIGRATION_REQUIRED',incompatible.map(item=>`${item.table}.${item.column}`).join(', '),incompatible);
}

export async function upgradeAppSchema(client, migration) {
  if(!migration) return {applied:false,reason:'different-app-schema'};
  const {contract,plan}=migration;
  if(migration.id!==plan.id||!/^[a-f0-9]{64}$/.test(migration.sha256||''))fail('APP_SCHEMA_CONTRACT_INVALID');
  validateSchemaPlan(plan,contract,{moduleKey:plan.moduleKey,domain:plan.domain});
  const domain=contract.domain;
  const relation=table=>quote(domain)+'.'+quote(table);
  const ledger=relation('_BonniRuntimeMigration');
  if(contract.version!==1||domain!==plan.domain) fail('APP_SCHEMA_CONTRACT_INVALID',migration.id);
  let locked=false;
  let phase='begin';
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SET LOCAL standard_conforming_strings='on'");
    // Keep this dedicated connection locked across the enum commit below.
    // A transaction lock alone would leave the two phases open to a second
    // updater. lock_timeout also bounds acquisition of this session lock.
    phase='migration-lock';
    await client.query('SELECT pg_advisory_lock($1)',[plan.lockId]);locked=true;
    await client.query('SET LOCAL search_path TO '+quote(domain));
    phase='check-existing-database';
    const anchor=await client.query('SELECT bool_and(to_regclass(name) IS NOT NULL) AS ready FROM unnest($1::text[]) AS names(name)',[plan.anchors.map(relation)]);
    let initialized=false;
    if(!anchor.rows[0]?.ready) {
      phase='initialize-empty-schema';
      await prepareEmptySchema(client,migration);initialized=true;
    }
    const marker=await client.query('SELECT to_regclass($1) AS name',[ledger]);
    if(marker.rows[0]?.name) {
      const saved=await client.query('SELECT "sha256" FROM '+ledger+' WHERE "id"=$1',[migration.id]);
      if(saved.rows.length) {
        if(saved.rows[0].sha256!==migration.sha256) fail('APP_SCHEMA_MIGRATION_CHANGED',migration.id);
        await client.query('COMMIT');return {applied:false,reason:'already-applied'};
      }
    }
    phase='check-existing-columns';
    await checkExistingRuntimeColumns(client,contract);
    phase='check-foreign-keys';
    await assertAppForeignKeyPlan(client,contract,plan.emptyForeignKeyTransitions);
    let addedTables=0,addedColumns=0,addedEnumValues=0;
    const enumAdditions=[];
    phase='extend-enums';
    for(const item of contract.enums) {
      const type=(await client.query('SELECT oid,typtype FROM pg_type WHERE typnamespace=to_regnamespace($1) AND typname=$2',[domain,item.name])).rows[0];
      if(!type) continue; // New types are created with the tables, below.
      if(type.typtype!=='e') fail('APP_SCHEMA_ENUM_MIGRATION_REQUIRED',item.name);
      const labels=new Set((await client.query('SELECT enumlabel FROM pg_enum WHERE enumtypid=$1',[type.oid])).rows.map(row=>row.enumlabel));
      for(let i=0;i<item.values.length;i++) {
        const value=item.values[i];
        if(labels.has(value)) continue;
        const before=item.values.slice(i+1).find(next=>labels.has(next));
        enumAdditions.push(`ALTER TYPE ${relation(item.name)} ADD VALUE IF NOT EXISTS ${literal(value)}${before ? ' BEFORE '+literal(before) : ''}`);
        labels.add(value);
      }
    }
    for(const statement of enumAdditions) {await client.query(statement);addedEnumValues++;}
    if(addedEnumValues) {
      // PostgreSQL forbids using newly added enum labels in column defaults
      // until COMMIT. Only additive labels are committed here; existing labels
      // and rows are untouched. Table/column changes remain atomic, and retry
      // after a later failure safely reuses the labels already committed.
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='10s'");
      await client.query("SET LOCAL statement_timeout='120s'");
      await client.query("SET LOCAL standard_conforming_strings='on'");
      await client.query('SET LOCAL search_path TO '+quote(domain));
    }
    const owner=domain+'_owner',runtime=domain+'_user';
    const roles=(await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[owner,runtime]])).rows.map(row=>row.rolname);
    phase='prepare-enums';
    for(const item of contract.enums) {
      const type=await client.query('SELECT oid,typtype FROM pg_type WHERE typnamespace=to_regnamespace($1) AND typname=$2',[domain,item.name]);
      if(!type.rows.length) {
        await client.query(item.create);
        if(roles.includes(owner)) await client.query(`ALTER TYPE ${relation(item.name)} OWNER TO ${quote(owner)}`);
      }
      else {
        const labels=await client.query('SELECT enumlabel FROM pg_enum WHERE enumtypid=$1',[type.rows[0].oid]);
        if(type.rows[0].typtype!=='e'||item.values.some(value=>!labels.rows.some(row=>row.enumlabel===value))) fail('APP_SCHEMA_ENUM_MIGRATION_REQUIRED',item.name);
      }
    }
    phase='prepare-tables-and-columns';
    for(const table of contract.tables) {
      const state=await client.query('SELECT c.relkind FROM pg_class c WHERE c.oid=to_regclass($1)',[relation(table.name)]);
      if(!state.rows.length) {
        await client.query(table.create);addedTables++;
        await client.query(`REVOKE ALL ON TABLE ${relation(table.name)} FROM PUBLIC`);
        if(roles.includes(owner)) await client.query(`ALTER TABLE ${relation(table.name)} OWNER TO ${quote(owner)}`);
        if(roles.includes(runtime)) await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${relation(table.name)} TO ${quote(runtime)}`);
      } else if(state.rows[0].relkind!=='r') fail('APP_SCHEMA_TABLE_KIND_INVALID',table.name);
      for(const column of table.columns) {
        let rows=(await client.query('SELECT format_type(atttypid,atttypmod) AS type,attnotnull AS required FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname=$2 AND attnum>0 AND NOT attisdropped',[relation(table.name),column.name])).rows;
        if(!rows.length) {
          // PostgreSQL rejects a required column without a default on nonempty
          // tables. Never fabricate business values or relax that constraint.
          await client.query(`ALTER TABLE ${relation(table.name)} ADD COLUMN ${quote(column.name)} ${column.definition}`);
          addedColumns++;
          rows=(await client.query('SELECT format_type(atttypid,atttypmod) AS type,attnotnull AS required FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname=$2',[relation(table.name),column.name])).rows;
        }
        if(rows[0]?.type!==column.type||rows[0]?.required!==column.required) fail('APP_SCHEMA_COLUMN_MIGRATION_REQUIRED',`${table.name}.${column.name}`);
      }
      const primary=(await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='p'",[relation(table.name)])).rows[0]?.definition;
      if(primary!==table.primaryKey) fail('APP_SCHEMA_PRIMARY_KEY_INVALID',table.name,[{table:table.name,status:'different-primary-key',expected:table.primaryKey,actual:primary||null}]);
    }
    phase='check-indexes';
    for(const item of contract.indexes) {
      const existing=await client.query('SELECT pg_get_indexdef(to_regclass($1)) AS definition',[relation(item.name)]);
      if(!existing.rows[0]?.definition) await client.query(item.create);
      else if(existing.rows[0].definition!==item.definition) fail('APP_SCHEMA_INDEX_MIGRATION_REQUIRED',item.name,[{table:item.table,name:item.name,status:'different-index',expected:item.definition,actual:existing.rows[0].definition}]);
    }
    // The app declares exact obsolete unique indexes and their replacements.
    // All replacements were verified above before an old rule can be removed.
    for(const item of plan.obsoleteIndexes) {
      const previous=(await client.query('SELECT pg_get_indexdef(to_regclass($1)) AS definition',[relation(item.name)])).rows[0]?.definition;
      if(!previous)continue;
      if(previous!==item.definition)fail('APP_SCHEMA_OLD_INDEX_INVALID',item.name);
      const constraint=(await client.query('SELECT conname FROM pg_constraint WHERE conindid=to_regclass($1)',[relation(item.name)])).rows[0];
      if(constraint)await client.query(`ALTER TABLE ${relation(item.table)} DROP CONSTRAINT ${quote(constraint.conname)}`);
      else await client.query(`DROP INDEX ${relation(item.name)}`);
    }
    phase='apply-foreign-keys';
    const foreignKeys=await applyAppForeignKeys(client,contract,plan.emptyForeignKeyTransitions);
    phase='record-migration';
    await client.query('CREATE TABLE IF NOT EXISTS '+ledger+' ("id" text PRIMARY KEY,"sha256" text NOT NULL,"appliedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await client.query('REVOKE ALL ON '+ledger+' FROM PUBLIC');
    await client.query('INSERT INTO '+ledger+' ("id","sha256") VALUES ($1,$2)',[migration.id,migration.sha256]);
    await client.query('COMMIT');
    return {applied:true,initialized,addedTables,addedColumns,addedEnumValues,...foreignKeys};
  } catch(error) {
    if(error instanceof Error)error.diagnostic={...error.diagnostic,schema:'bonni.schema-diagnostic/v1',databaseDomain:domain,migrationId:migration.id,phase};
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    if(locked) await client.query('SELECT pg_advisory_unlock($1)',[plan.lockId]).catch(()=>{});
  }
}
