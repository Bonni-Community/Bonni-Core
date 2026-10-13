-- Additive upgrade for independent Stueberl settlement and explicit history import.
-- Existing business records and earlier migration hashes are immutable.
-- The Core Ops runner owns the transaction and migration ledger.
-- Optional base tables are created by module installation if not installed yet.
DO $migration$
BEGIN
  IF to_regclass('stueberl."StueberlKontorReceivable"') IS NULL
     OR to_regclass('kontor."KontorStueberlReceivable"') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kontor_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kontor_user') THEN
    RAISE EXCEPTION 'BONNI_OPS_HISTORY_BASE_CONTRACT_INVALID';
  END IF;
END $migration$;

ALTER TABLE IF EXISTS "stueberl"."StueberlKontorReceivable" ADD COLUMN IF NOT EXISTS "contractVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS "stueberl"."StueberlKontorReceivable" ADD COLUMN IF NOT EXISTS "lineItemsJson" JSONB;
ALTER TABLE IF EXISTS "stueberl"."StueberlKontorReceivable" ADD COLUMN IF NOT EXISTS "settlementOwner" TEXT NOT NULL DEFAULT 'KONTOR';
ALTER TABLE IF EXISTS "stueberl"."ProductVersion" ADD COLUMN IF NOT EXISTS "salesTaxJson" JSONB;
ALTER TABLE IF EXISTS "stueberl"."StueberlSalesConfiguration" ADD COLUMN IF NOT EXISTS "kontorIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS "kontor"."KontorAccountingConfiguration" ADD COLUMN IF NOT EXISTS "stueberlPostingProfile" JSONB;
ALTER TABLE IF EXISTS "kontor"."KontorAccountingConfiguration" ADD COLUMN IF NOT EXISTS "stueberlPostingRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "kontor"."KontorStueberlReceivable" ADD COLUMN IF NOT EXISTS "postingSnapshot" JSONB;
ALTER TABLE IF EXISTS "kontor"."KontorStueberlReceivable" ADD COLUMN IF NOT EXISTS "postingProfileRevision" INTEGER;
ALTER TABLE IF EXISTS "kontor"."KontorStueberlReceivable" ADD COLUMN IF NOT EXISTS "historySourceHash" TEXT;
ALTER TABLE IF EXISTS "kontor"."KontorFinanceEntry" ADD COLUMN IF NOT EXISTS "taxOriginEntryId" TEXT;

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlHistoryRun" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'COLLECTING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdByAccountId" TEXT NOT NULL,
    "confirmedByAccountId" TEXT,
    "confirmKey" TEXT,
    "confirmHash" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "requestMessageId" TEXT,
    "lastError" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KontorStueberlHistoryRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlHistoryRow" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "receivableExternalId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sourceHash" TEXT,
    "planHash" TEXT,
    "payload" JSONB NOT NULL,
    "importedReceivableId" TEXT,
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KontorStueberlHistoryRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlHistoryRun_requestKey_key" ON "kontor"."KontorStueberlHistoryRun"("requestKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlHistoryRun_confirmKey_key" ON "kontor"."KontorStueberlHistoryRun"("confirmKey");
CREATE INDEX IF NOT EXISTS "KontorStueberlHistoryRun_status_createdAt_idx" ON "kontor"."KontorStueberlHistoryRun"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "KontorStueberlHistoryRow_runId_status_idx" ON "kontor"."KontorStueberlHistoryRow"("runId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlHistoryRow_runId_receivableExternalId_key" ON "kontor"."KontorStueberlHistoryRow"("runId", "receivableExternalId");
CREATE INDEX IF NOT EXISTS "StueberlKontorReceivable_settlementOwner_status_lastSettlem_idx" ON "stueberl"."StueberlKontorReceivable"("settlementOwner", "status", "lastSettlementAt");

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='kontor."KontorStueberlHistoryRow"'::regclass AND conname='KontorStueberlHistoryRow_runId_fkey') THEN
    ALTER TABLE "kontor"."KontorStueberlHistoryRow" ADD CONSTRAINT "KontorStueberlHistoryRow_runId_fkey" FOREIGN KEY ("runId") REFERENCES "kontor"."KontorStueberlHistoryRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $migration$;
ALTER TABLE "kontor"."KontorStueberlHistoryRun" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorStueberlHistoryRow" OWNER TO "kontor_owner";
REVOKE ALL ON TABLE "kontor"."KontorStueberlHistoryRun", "kontor"."KontorStueberlHistoryRow" FROM PUBLIC, "stueberl_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kontor"."KontorStueberlHistoryRun", "kontor"."KontorStueberlHistoryRow" TO "kontor_user";

-- Reject a pre-existing object with a wrong type, nullability or default.
DO $migration$
DECLARE expected RECORD; actual RECORD; relation OID;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('stueberl', 'StueberlKontorReceivable', 'contractVersion', 'integer', TRUE, '1'),
    ('stueberl', 'StueberlKontorReceivable', 'lineItemsJson', 'jsonb', FALSE, NULL),
    ('stueberl', 'StueberlKontorReceivable', 'settlementOwner', 'text', TRUE, '''KONTOR''::text'),
    ('stueberl', 'ProductVersion', 'salesTaxJson', 'jsonb', FALSE, NULL),
    ('stueberl', 'StueberlSalesConfiguration', 'kontorIntegrationEnabled', 'boolean', TRUE, 'false'),
    ('kontor', 'KontorAccountingConfiguration', 'stueberlPostingProfile', 'jsonb', FALSE, NULL),
    ('kontor', 'KontorAccountingConfiguration', 'stueberlPostingRevision', 'integer', TRUE, '0'),
    ('kontor', 'KontorStueberlReceivable', 'postingSnapshot', 'jsonb', FALSE, NULL),
    ('kontor', 'KontorStueberlReceivable', 'postingProfileRevision', 'integer', FALSE, NULL),
    ('kontor', 'KontorStueberlReceivable', 'historySourceHash', 'text', FALSE, NULL),
    ('kontor', 'KontorFinanceEntry', 'taxOriginEntryId', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'id', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'requestKey', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'requestHash', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'fromDate', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'toDate', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'cutoffAt', 'timestamp without time zone', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'cursor', 'text', TRUE, '''''::text'),
    ('kontor', 'KontorStueberlHistoryRun', 'status', 'text', TRUE, '''COLLECTING''::text'),
    ('kontor', 'KontorStueberlHistoryRun', 'revision', 'integer', TRUE, '1'),
    ('kontor', 'KontorStueberlHistoryRun', 'createdByAccountId', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'confirmedByAccountId', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'confirmKey', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'confirmHash', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'confirmedAt', 'timestamp without time zone', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'requestMessageId', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'lastError', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'leaseUntil', 'timestamp without time zone', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRun', 'createdAt', 'timestamp without time zone', TRUE, 'CURRENT_TIMESTAMP'),
    ('kontor', 'KontorStueberlHistoryRun', 'updatedAt', 'timestamp without time zone', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'id', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'runId', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'sourceId', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'receivableExternalId', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'description', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'paidAt', 'timestamp without time zone', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'amountCents', 'integer', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'status', 'text', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'reason', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'sourceHash', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'planHash', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'payload', 'jsonb', TRUE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'importedReceivableId', 'text', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'importedAt', 'timestamp without time zone', FALSE, NULL),
    ('kontor', 'KontorStueberlHistoryRow', 'createdAt', 'timestamp without time zone', TRUE, 'CURRENT_TIMESTAMP'),
    ('kontor', 'KontorStueberlHistoryRow', 'updatedAt', 'timestamp without time zone', TRUE, NULL)
  ) AS c(schema_name,table_name,column_name,type_name,not_null,default_value)
  LOOP
    relation:=to_regclass(format('%I.%I',expected.schema_name,expected.table_name));
    IF relation IS NULL THEN CONTINUE; END IF;
    SELECT format_type(a.atttypid,NULL) AS type_name,a.atttypmod,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value INTO actual
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=relation AND a.attname=expected.column_name AND a.attnum>0 AND NOT a.attisdropped;
    IF actual.type_name IS DISTINCT FROM expected.type_name
       OR actual.attnotnull IS DISTINCT FROM expected.not_null
       OR actual.default_value IS DISTINCT FROM expected.default_value
       OR (expected.type_name='timestamp without time zone' AND actual.atttypmod<>3) THEN
      RAISE EXCEPTION 'BONNI_OPS_HISTORY_COLUMN_CONTRACT_INVALID: %.%.%', expected.schema_name,expected.table_name,expected.column_name;
    END IF;
  END LOOP;
END $migration$;

DO $migration$
DECLARE expected RECORD; actual RECORD;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('kontor', 'KontorStueberlHistoryRun', 'KontorStueberlHistoryRun_requestKey_key', ARRAY['requestKey']::text[], TRUE),
    ('kontor', 'KontorStueberlHistoryRun', 'KontorStueberlHistoryRun_confirmKey_key', ARRAY['confirmKey']::text[], TRUE),
    ('kontor', 'KontorStueberlHistoryRun', 'KontorStueberlHistoryRun_status_createdAt_idx', ARRAY['status','createdAt']::text[], FALSE),
    ('kontor', 'KontorStueberlHistoryRow', 'KontorStueberlHistoryRow_runId_status_idx', ARRAY['runId','status']::text[], FALSE),
    ('kontor', 'KontorStueberlHistoryRow', 'KontorStueberlHistoryRow_runId_receivableExternalId_key', ARRAY['runId','receivableExternalId']::text[], TRUE),
    ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_settlementOwner_status_lastSettlem_idx', ARRAY['settlementOwner','status','lastSettlementAt']::text[], FALSE),
    ('kontor', 'KontorStueberlHistoryRun', 'KontorStueberlHistoryRun_pkey', ARRAY['id']::text[], TRUE),
    ('kontor', 'KontorStueberlHistoryRow', 'KontorStueberlHistoryRow_pkey', ARRAY['id']::text[], TRUE)
  ) AS c(schema_name,table_name,index_name,column_names,is_unique)
  LOOP
    SELECT i.indisunique,i.indisvalid,i.indisready,i.indpred,i.indexprs,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
            JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS column_names
    INTO actual FROM pg_index i
    WHERE i.indexrelid=to_regclass(format('%I.%I',expected.schema_name,expected.index_name))
      AND i.indrelid=to_regclass(format('%I.%I',expected.schema_name,expected.table_name));
    IF actual.indisunique IS DISTINCT FROM expected.is_unique OR actual.indisvalid IS DISTINCT FROM TRUE
       OR actual.indisready IS DISTINCT FROM TRUE OR actual.indpred IS NOT NULL OR actual.indexprs IS NOT NULL
       OR actual.column_names IS DISTINCT FROM expected.column_names THEN
      RAISE EXCEPTION 'BONNI_OPS_HISTORY_INDEX_CONTRACT_INVALID: %', expected.index_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='kontor."KontorStueberlHistoryRow"'::regclass
      AND c.conname='KontorStueberlHistoryRow_runId_fkey' AND c.contype='f'
      AND c.confrelid='kontor."KontorStueberlHistoryRun"'::regclass
      AND c.confdeltype='r' AND c.confupdtype='c' AND c.convalidated AND NOT c.condeferrable
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='runId')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[]
  ) THEN RAISE EXCEPTION 'BONNI_OPS_HISTORY_FOREIGN_KEY_INVALID'; END IF;
  FOR expected IN SELECT * FROM (VALUES ('KontorStueberlHistoryRun'),('KontorStueberlHistoryRow')) AS c(table_name)
  LOOP
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass(format('kontor.%I',expected.table_name))) IS DISTINCT FROM 'kontor_owner'
       OR NOT has_table_privilege('kontor_user',format('kontor.%I',expected.table_name),'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('stueberl_user',format('kontor.%I',expected.table_name),'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'BONNI_OPS_HISTORY_OWNERSHIP_OR_GRANT_INVALID: %',expected.table_name;
    END IF;
  END LOOP;
END $migration$;
