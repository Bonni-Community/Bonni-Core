const quote=value=>'"'+value.replaceAll('"','""')+'"';
const relation=(contract,table)=>quote(contract.domain)+'.'+quote(table);
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const actions=new Map([['NO ACTION','a'],['RESTRICT','r'],['CASCADE','c'],['SET NULL','n'],['SET DEFAULT','d']]);

function expectedKey(item,domain) {
  const parsed=/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]+)\) REFERENCES "([^"]+)"\(([^)]+)\) ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT) ON UPDATE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT);$/.exec(item.create);
  const columns=text=>{
    if(!/^"[^"]+"(?:,\s*"[^"]+")*$/.test(text))throw new Error('APP_SCHEMA_FOREIGN_KEY_CONTRACT_INVALID:'+item.name);
    return [...text.matchAll(/"([^"]+)"/g)].map(match=>match[1]);
  };
  if(!parsed||parsed[1]!==item.table||parsed[2]!==item.name)throw new Error('APP_SCHEMA_FOREIGN_KEY_CONTRACT_INVALID:'+item.name);
  return {table:item.table,name:item.name,columns:columns(parsed[3]),targetSchema:domain,targetTable:parsed[4],targetColumns:columns(parsed[5]),deleteAction:actions.get(parsed[6]),updateAction:actions.get(parsed[7]),matchType:'s',deferrable:false,deferred:false};
}

export async function readAppForeignKeys(client,contract) {
  return (await client.query(`SELECT t.relname AS "table",c.conname AS name,c.contype AS kind,
    ns.nspname AS "targetSchema",p.relname AS "targetTable",
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS "targetColumns",
    c.confdeltype AS "deleteAction",c.confupdtype AS "updateAction",c.confmatchtype AS "matchType",
    c.condeferrable AS deferrable,c.condeferred AS deferred,c.convalidated AS validated,
    pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_class p ON p.oid=c.confrelid LEFT JOIN pg_namespace ns ON ns.oid=p.relnamespace
    WHERE n.nspname=$2 AND c.conname=ANY($1::text[])`,[contract.constraints.map(item=>item.name),contract.domain])).rows;
}
function matchingIdentity(actual,expected) {
  return actual.kind==='f'&&actual.table===expected.table&&actual.targetSchema===expected.targetSchema
    &&actual.targetTable===expected.targetTable&&same(actual.columns,expected.columns)&&same(actual.targetColumns,expected.targetColumns);
}
function matchingRules(actual,expected) {
  return ['deleteAction','updateAction','matchType','deferrable','deferred'].every(key=>actual[key]===expected[key]);
}
function knownRetiredKey(actual,expected,transitions) {
  const known=transitions.find(item=>item.name===expected.name&&item.table===expected.table);
  return !!known&&same(expected.columns,known.columns)&&expected.targetTable===known.toTable
    &&same(expected.targetColumns,known.toColumns)&&actual.targetTable===known.fromTable
    &&same(actual.targetColumns,known.fromColumns)&&matchingRules(actual,expected)
    &&matchingIdentity({...actual,targetTable:known.toTable,targetColumns:known.toColumns},expected);
}
function keyOf(item){return item.table+'\0'+item.name;}

// This report contains schema metadata only, never business rows, credentials
// or connection strings. It can also be used by read-only diagnostics.
export async function inspectAppForeignKeys(client,contract,transitions=[]) {
  const actual=new Map((await readAppForeignKeys(client,contract)).map(item=>[keyOf(item),item]));
  return contract.constraints.map(item=>{
    const expected=expectedKey(item,contract.domain),present=actual.get(keyOf(item));
    if(!present)return {name:item.name,table:item.table,status:'missing',expected,actual:null};
    if(knownRetiredKey(present,expected,transitions))return {name:item.name,table:item.table,status:'retired-target',expected,actual:present};
    if(!matchingIdentity(present,expected))return {name:item.name,table:item.table,status:'different-target',expected,actual:present};
    if(present.matchType!=='s'||![...actions.values()].includes(present.deleteAction)||![...actions.values()].includes(present.updateAction)) {
      return {name:item.name,table:item.table,status:'unsupported-rule',expected,actual:present};
    }
    return {name:item.name,table:item.table,status:matchingRules(present,expected)?(present.validated?'valid':'validate'):'replace-rules',expected,actual:present};
  });
}

export async function assertAppForeignKeyPlan(client,contract,transitions=[]) {
  let report=await inspectAppForeignKeys(client,contract,transitions);
  const retired=report.filter(item=>item.status==='retired-target');
  if(retired.length) {
    // The caller owns the transaction. Block writes before testing for archive
    // references and retain these locks through DROP + ADD + ledger commit.
    // The upgrade calls this again after a possible enum commit, so it also
    // rechecks rows and metadata that could have changed between its phases.
    const tables=[...new Set(retired.map(item=>item.table))].sort();
    await client.query(`LOCK TABLE ${tables.map(table=>relation(contract,table)).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    report=await inspectAppForeignKeys(client,contract,transitions);
    for(const item of report.filter(item=>item.status==='retired-target')) {
      if(!tables.includes(item.table)) {item.status='different-target';continue;}
      const referenced=item.expected.columns.map(column=>quote(column)+' IS NOT NULL').join(' OR ');
      const result=await client.query(`SELECT EXISTS(SELECT 1 FROM ${relation(contract,item.table)} WHERE ${referenced}) AS referenced`);
      item.status=result.rows[0]?.referenced?'legacy-references-present':'replace-empty-retired-target';
    }
  }
  const issues=report.filter(item=>['different-target','unsupported-rule','legacy-references-present'].includes(item.status));
  for(const item of report.filter(item=>['validate','replace-rules'].includes(item.status)&&!item.actual.validated)) {
    // MATCH SIMPLE: a row with any NULL key is exempt. Do not remove or map an
    // orphan, even when a previous NOT VALID constraint allowed it to remain.
    const nonnull=item.expected.columns.map(column=>'child.'+quote(column)+' IS NOT NULL').join(' AND ');
    const joins=item.expected.columns.map((column,index)=>'parent.'+quote(item.expected.targetColumns[index])+'=child.'+quote(column)).join(' AND ');
    const result=await client.query(`SELECT EXISTS(SELECT 1 FROM ${relation(contract,item.table)} child WHERE ${nonnull} AND NOT EXISTS(SELECT 1 FROM ${relation(contract,item.expected.targetTable)} parent WHERE ${joins})) AS orphan`);
    if(result.rows[0]?.orphan)issues.push({...item,status:'orphaned-rows'});
  }
  if(issues.length) {
    const error=new Error('APP_SCHEMA_CONSTRAINT_MIGRATION_REQUIRED:'+issues.map(item=>item.name).join(', '));
    error.schemaIssues=issues;
    // The module loader only logs error.stack. Emit all expected/actual metadata
    // here so the next investigation does not require another blind update.
    console.error('[AppSchema] Fremdschluessel-Abgleich:',JSON.stringify(issues));
    throw error;
  }
  return report;
}

export async function applyAppForeignKeys(client,contract,transitions=[]) {
  // Re-read after the possible enum commit. Table/FK changes are in the current
  // transaction; a failed ADD/VALIDATE rolls back the old constraint as well.
  const report=await assertAppForeignKeyPlan(client,contract,transitions);
  let repairedForeignKeys=0,validatedForeignKeys=0,reboundForeignKeys=0;
  const statements=new Map(contract.constraints.map(item=>[keyOf(item),item.create]));
  for(const item of report) {
    if(item.status==='valid')continue;
    if(item.status==='validate') {
      await client.query(`ALTER TABLE ${relation(contract,item.table)} VALIDATE CONSTRAINT ${quote(item.name)}`);
      validatedForeignKeys++;
    } else {
      if(item.status==='replace-rules'||item.status==='replace-empty-retired-target') {
        await client.query(`ALTER TABLE ${relation(contract,item.table)} DROP CONSTRAINT ${quote(item.name)}`);
        if(item.status==='replace-empty-retired-target')reboundForeignKeys++;
        else repairedForeignKeys++;
      }
      await client.query(statements.get(keyOf(item)));
    }
  }
  return {repairedForeignKeys,validatedForeignKeys,reboundForeignKeys};
}
