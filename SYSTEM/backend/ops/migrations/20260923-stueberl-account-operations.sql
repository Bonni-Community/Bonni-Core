-- Additive account storno and credit ledger; original records stay intact.
-- Core Ops owns the transaction. Repeat execution is safe.
ALTER TABLE IF EXISTS "stueberl"."TabSession" ADD COLUMN IF NOT EXISTS "dailySequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "stueberl"."StueberlKontorReceivable" ADD COLUMN IF NOT EXISTS "reversedAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "stueberl"."StueberlKontorReceivable" ADD COLUMN IF NOT EXISTS "creditAppliedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "stueberl"."StueberlKontorCashPayment" ADD COLUMN IF NOT EXISTS "expectedAccountRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS "kontor"."KontorStueberlReceivable" ADD COLUMN IF NOT EXISTS "reversedAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "kontor"."KontorStueberlReceivable" ADD COLUMN IF NOT EXISTS "creditAppliedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS "stueberl"."TabSession" DROP CONSTRAINT IF EXISTS "TabSession_memberId_businessDate_key";
DROP INDEX IF EXISTS "stueberl"."TabSession_memberId_businessDate_key";
DO $migration$ BEGIN IF to_regclass('stueberl."TabSession"') IS NOT NULL THEN CREATE UNIQUE INDEX IF NOT EXISTS "TabSession_memberId_businessDate_dailySequence_key" ON "stueberl"."TabSession"("memberId","businessDate","dailySequence"); END IF; END $migration$;
CREATE TABLE IF NOT EXISTS "stueberl"."StueberlAccountOperation" (
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "receivableExternalId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "creditDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorAccountId" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "result" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StueberlAccountOperation_pkey" PRIMARY KEY ("operationId")
);
CREATE INDEX IF NOT EXISTS "StueberlAccountOperation_memberId_owner_createdAt_idx" ON "stueberl"."StueberlAccountOperation"("memberId", "owner", "createdAt");
CREATE INDEX IF NOT EXISTS "StueberlAccountOperation_receivableExternalId_status_idx" ON "stueberl"."StueberlAccountOperation"("receivableExternalId", "status");
ALTER TABLE "stueberl"."StueberlAccountOperation" OWNER TO "stueberl_owner";
REVOKE ALL ON "stueberl"."StueberlAccountOperation" FROM PUBLIC, "kontor_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON "stueberl"."StueberlAccountOperation" TO "stueberl_user";
CREATE TABLE IF NOT EXISTS "stueberl"."StueberlLocalAccountCredit" (
    "memberId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastOperationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StueberlLocalAccountCredit_pkey" PRIMARY KEY ("memberId")
);
ALTER TABLE "stueberl"."StueberlLocalAccountCredit" OWNER TO "stueberl_owner";
REVOKE ALL ON "stueberl"."StueberlLocalAccountCredit" FROM PUBLIC, "kontor_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON "stueberl"."StueberlLocalAccountCredit" TO "stueberl_user";
CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlAccountOperation" (
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "receivableExternalId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "creditDeltaCents" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorAccountId" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "responseMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KontorStueberlAccountOperation_pkey" PRIMARY KEY ("operationId")
);
CREATE INDEX IF NOT EXISTS "KontorStueberlAccountOperation_memberId_owner_createdAt_idx" ON "kontor"."KontorStueberlAccountOperation"("memberId", "owner", "createdAt");
CREATE INDEX IF NOT EXISTS "KontorStueberlAccountOperation_receivableExternalId_idx" ON "kontor"."KontorStueberlAccountOperation"("receivableExternalId");
ALTER TABLE "kontor"."KontorStueberlAccountOperation" OWNER TO "kontor_owner";
REVOKE ALL ON "kontor"."KontorStueberlAccountOperation" FROM PUBLIC, "stueberl_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON "kontor"."KontorStueberlAccountOperation" TO "kontor_user";
CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlImportedCredit" (
    "memberId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastOperationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KontorStueberlImportedCredit_pkey" PRIMARY KEY ("memberId")
);
ALTER TABLE "kontor"."KontorStueberlImportedCredit" OWNER TO "kontor_owner";
REVOKE ALL ON "kontor"."KontorStueberlImportedCredit" FROM PUBLIC, "stueberl_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON "kontor"."KontorStueberlImportedCredit" TO "kontor_user";
DO $migration$
DECLARE expected RECORD; actual RECORD; relation OID;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('stueberl','StueberlAccountOperation','operationId','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','requestHash','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','memberId','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','receivableExternalId','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','owner','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','kind','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','amountCents','integer',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','creditDeltaCents','integer',TRUE,'0'),
    ('stueberl','StueberlAccountOperation','occurredAt','timestamp without time zone',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','reason','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','actorAccountId','text',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','command','jsonb',TRUE,NULL),
    ('stueberl','StueberlAccountOperation','result','jsonb',FALSE,NULL),
    ('stueberl','StueberlAccountOperation','status','text',TRUE,'''PENDING''::text'),
    ('stueberl','StueberlAccountOperation','error','text',FALSE,NULL),
    ('stueberl','StueberlAccountOperation','createdAt','timestamp without time zone',TRUE,'CURRENT_TIMESTAMP'),
    ('stueberl','StueberlAccountOperation','updatedAt','timestamp without time zone',TRUE,NULL),
    ('stueberl','StueberlLocalAccountCredit','memberId','text',TRUE,NULL),
    ('stueberl','StueberlLocalAccountCredit','balanceCents','integer',TRUE,'0'),
    ('stueberl','StueberlLocalAccountCredit','revision','integer',TRUE,'0'),
    ('stueberl','StueberlLocalAccountCredit','lastOperationId','text',FALSE,NULL),
    ('stueberl','StueberlLocalAccountCredit','updatedAt','timestamp without time zone',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','operationId','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','requestHash','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','memberId','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','receivableExternalId','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','owner','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','kind','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','amountCents','integer',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','creditDeltaCents','integer',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','occurredAt','timestamp without time zone',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','reason','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','actorAccountId','text',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','command','jsonb',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','result','jsonb',TRUE,NULL),
    ('kontor','KontorStueberlAccountOperation','responseMessageId','text',FALSE,NULL),
    ('kontor','KontorStueberlAccountOperation','createdAt','timestamp without time zone',TRUE,'CURRENT_TIMESTAMP'),
    ('kontor','KontorStueberlImportedCredit','memberId','text',TRUE,NULL),
    ('kontor','KontorStueberlImportedCredit','balanceCents','integer',TRUE,'0'),
    ('kontor','KontorStueberlImportedCredit','revision','integer',TRUE,'0'),
    ('kontor','KontorStueberlImportedCredit','lastOperationId','text',FALSE,NULL),
    ('kontor','KontorStueberlImportedCredit','updatedAt','timestamp without time zone',TRUE,NULL),
    ('stueberl','TabSession','dailySequence','integer',TRUE,'0'),
    ('stueberl','StueberlKontorReceivable','reversedAmountCents','integer',TRUE,'0'),
    ('stueberl','StueberlKontorReceivable','creditAppliedCents','integer',TRUE,'0'),
    ('stueberl','StueberlKontorCashPayment','expectedAccountRevision','integer',TRUE,'1'),
    ('kontor','KontorStueberlReceivable','reversedAmountCents','integer',TRUE,'0'),
    ('kontor','KontorStueberlReceivable','creditAppliedCents','integer',TRUE,'0')
  ) AS c(schema_name,table_name,column_name,type_name,not_null,default_value)
  LOOP
    relation:=to_regclass(format('%I.%I',expected.schema_name,expected.table_name));
    IF relation IS NULL THEN CONTINUE; END IF;
    SELECT format_type(a.atttypid,NULL) AS type_name,a.atttypmod,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value INTO actual
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=relation AND a.attname=expected.column_name AND a.attnum>0 AND NOT a.attisdropped;
    IF actual.type_name IS DISTINCT FROM expected.type_name OR actual.attnotnull IS DISTINCT FROM expected.not_null
       OR actual.default_value IS DISTINCT FROM expected.default_value
       OR (expected.type_name='timestamp without time zone' AND actual.atttypmod<>3) THEN
      RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_COLUMN_CONTRACT_INVALID: %.%.%',expected.schema_name,expected.table_name,expected.column_name;
    END IF;
  END LOOP;
END $migration$;
DO $migration$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='stueberl."StueberlAccountOperation"'::regclass AND c.contype='p' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='operationId')]::smallint[]) THEN
  RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_PRIMARY_KEY_INVALID: StueberlAccountOperation';
 END IF;
END $migration$;
DO $migration$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='stueberl."StueberlLocalAccountCredit"'::regclass AND c.contype='p' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='memberId')]::smallint[]) THEN
  RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_PRIMARY_KEY_INVALID: StueberlLocalAccountCredit';
 END IF;
END $migration$;
DO $migration$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='kontor."KontorStueberlAccountOperation"'::regclass AND c.contype='p' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='operationId')]::smallint[]) THEN
  RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_PRIMARY_KEY_INVALID: KontorStueberlAccountOperation';
 END IF;
END $migration$;
DO $migration$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='kontor."KontorStueberlImportedCredit"'::regclass AND c.contype='p' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='memberId')]::smallint[]) THEN
  RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_PRIMARY_KEY_INVALID: KontorStueberlImportedCredit';
 END IF;
END $migration$;
DO $migration$
DECLARE columns text[];
BEGIN
 IF to_regclass('stueberl."TabSession"') IS NOT NULL THEN
  SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
   JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position)
  INTO columns FROM pg_index i WHERE i.indexrelid=to_regclass('stueberl."TabSession_memberId_businessDate_dailySequence_key"')
   AND i.indrelid='stueberl."TabSession"'::regclass AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL;
  IF columns IS DISTINCT FROM ARRAY['memberId','businessDate','dailySequence']::text[] THEN
   RAISE EXCEPTION 'BONNI_OPS_ACCOUNT_DAILY_SESSION_INDEX_INVALID';
  END IF;
 END IF;
END $migration$;
