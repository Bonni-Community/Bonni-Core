-- Bonni Core: Kontor-owned projection of explicitly released Hocket event
-- receivables. This migration is expand-only and intentionally creates no
-- ledger accounts, tax mappings or posting lines.

DO $migration$
DECLARE
  missing_contract TEXT;
BEGIN
  SELECT string_agg(required_object, ', ' ORDER BY required_object)
  INTO missing_contract
  FROM (
    VALUES
      ('schema:kontor', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'kontor')),
      ('schema:hocket', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'hocket')),
      ('role:kontor_owner', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kontor_owner')),
      ('role:kontor_user', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kontor_user')),
      ('role:hocket_owner', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hocket_owner')),
      ('role:hocket_user', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hocket_user')),
      ('table:hocket.HocketRecord', to_regclass('hocket."HocketRecord"') IS NOT NULL)
  ) AS required(required_object, present)
  WHERE NOT present;

  IF missing_contract IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_KONTOR_BRIDGE_BASE_CONTRACT_INVALID',
      DETAIL = missing_contract;
  END IF;
END
$migration$;

-- Hocket keeps its single scoped JSON delegate. Routing metadata is additive:
-- old records remain LEGACY and nullable tenant/event references preserve the
-- existing v0.2 rows while allowing bounded SETTLEMENT_INBOX lookups.
ALTER TABLE "hocket"."HocketRecord"
  ADD COLUMN IF NOT EXISTS "recordType" TEXT NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT,
  ADD COLUMN IF NOT EXISTS "eventId" TEXT;

CREATE INDEX IF NOT EXISTS "HocketRecord_recordType_tenantId_eventId_updatedAt_idx"
  ON "hocket"."HocketRecord" ("recordType", "tenantId", "eventId", "updatedAt");

ALTER TABLE "hocket"."HocketRecord" OWNER TO "hocket_owner";
REVOKE ALL ON TABLE "hocket"."HocketRecord" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hocket"."HocketRecord" TO "hocket_user";

CREATE TABLE IF NOT EXISTS "kontor"."KontorHocketReceivable" (
  "id" TEXT NOT NULL,
  "receivableExternalId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "requestMessageId" TEXT,
  "requestPayloadHash" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "creditorOrganizationId" TEXT NOT NULL,
  "debtorOrganizationId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "description" TEXT NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "lineCount" INTEGER NOT NULL,
  "sourceReference" TEXT NOT NULL,
  "releasedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "receivedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "appliedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "openAmountCents" INTEGER NOT NULL,
  "creditGeneratedCents" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastPaymentMethod" TEXT,
  "lastPaymentExternalId" TEXT,
  "reversalIdempotencyKey" TEXT,
  "reversalRequestHash" TEXT,
  "reversalReason" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversedByAccountId" TEXT,
  "subledgerId" TEXT NOT NULL,
  "subledgerItemId" TEXT NOT NULL,
  "financeEntryId" TEXT NOT NULL,
  "settlementMessageId" TEXT,
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KontorHocketReceivable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorHocketSettlementOutbox" (
  "id" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "correlationId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "messageId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KontorHocketSettlementOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorHocketPayment" (
  "id" TEXT NOT NULL,
  "paymentExternalId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestPayloadHash" TEXT NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "receivableId" TEXT NOT NULL,
  "creditorOrganizationId" TEXT NOT NULL,
  "debtorOrganizationId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "method" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "appliedAmountCents" INTEGER NOT NULL,
  "creditGeneratedCents" INTEGER NOT NULL DEFAULT 0,
  "financePaymentAllocationId" TEXT,
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KontorHocketPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorHocketOrganizationCredit" (
  "id" TEXT NOT NULL,
  "creditorOrganizationId" TEXT NOT NULL,
  "debtorOrganizationId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "balanceCents" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KontorHocketOrganizationCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorHocketCreditEntry" (
  "id" TEXT NOT NULL,
  "organizationCreditId" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "balanceAfterCents" INTEGER NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'OVERPAYMENT',
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KontorHocketCreditEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_receivableExternalId_key"
  ON "kontor"."KontorHocketReceivable" ("receivableExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_correlationId_key"
  ON "kontor"."KontorHocketReceivable" ("correlationId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_requestMessageId_key"
  ON "kontor"."KontorHocketReceivable" ("requestMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_sourceReference_key"
  ON "kontor"."KontorHocketReceivable" ("sourceReference");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_subledgerItemId_key"
  ON "kontor"."KontorHocketReceivable" ("subledgerItemId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_financeEntryId_key"
  ON "kontor"."KontorHocketReceivable" ("financeEntryId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_reversalIdempotencyKey_key"
  ON "kontor"."KontorHocketReceivable" ("reversalIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketReceivable_event_settlement_org_pair_key"
  ON "kontor"."KontorHocketReceivable"
  ("eventId", "settlementId", "creditorOrganizationId", "debtorOrganizationId", "currency");
CREATE INDEX IF NOT EXISTS "KontorHocketReceivable_org_pair_status_idx"
  ON "kontor"."KontorHocketReceivable"
  ("creditorOrganizationId", "debtorOrganizationId", "status");
CREATE INDEX IF NOT EXISTS "KontorHocketReceivable_status_releasedAt_idx"
  ON "kontor"."KontorHocketReceivable" ("status", "releasedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketSettlementOutbox_idempotencyKey_key"
  ON "kontor"."KontorHocketSettlementOutbox" ("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketSettlementOutbox_sourceRecordId_key"
  ON "kontor"."KontorHocketSettlementOutbox" ("sourceRecordId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketSettlementOutbox_receivableId_revision_key"
  ON "kontor"."KontorHocketSettlementOutbox" ("receivableId", "revision");
CREATE INDEX IF NOT EXISTS "KontorHocketSettlementOutbox_status_createdAt_idx"
  ON "kontor"."KontorHocketSettlementOutbox" ("status", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketPayment_paymentExternalId_key"
  ON "kontor"."KontorHocketPayment" ("paymentExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketPayment_idempotencyKey_key"
  ON "kontor"."KontorHocketPayment" ("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketPayment_evidenceReference_key"
  ON "kontor"."KontorHocketPayment" ("evidenceReference");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketPayment_financePaymentAllocationId_key"
  ON "kontor"."KontorHocketPayment" ("financePaymentAllocationId");
CREATE INDEX IF NOT EXISTS "KontorHocketPayment_receivableId_paidAt_idx"
  ON "kontor"."KontorHocketPayment" ("receivableId", "paidAt");
CREATE INDEX IF NOT EXISTS "KontorHocketPayment_org_pair_paidAt_idx"
  ON "kontor"."KontorHocketPayment"
  ("creditorOrganizationId", "debtorOrganizationId", "paidAt");

CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketOrganizationCredit_org_pair_currency_key"
  ON "kontor"."KontorHocketOrganizationCredit"
  ("creditorOrganizationId", "debtorOrganizationId", "currency");
CREATE INDEX IF NOT EXISTS "KontorHocketOrganizationCredit_debtor_currency_idx"
  ON "kontor"."KontorHocketOrganizationCredit" ("debtorOrganizationId", "currency");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorHocketCreditEntry_paymentId_key"
  ON "kontor"."KontorHocketCreditEntry" ("paymentId");
CREATE INDEX IF NOT EXISTS "KontorHocketCreditEntry_credit_createdAt_idx"
  ON "kontor"."KontorHocketCreditEntry" ("organizationCreditId", "createdAt");
CREATE INDEX IF NOT EXISTS "KontorHocketCreditEntry_receivable_createdAt_idx"
  ON "kontor"."KontorHocketCreditEntry" ("receivableId", "createdAt");

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorHocketSettlementOutbox_receivableId_fkey'
      AND conrelid = 'kontor."KontorHocketSettlementOutbox"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorHocketSettlementOutbox"
      ADD CONSTRAINT "KontorHocketSettlementOutbox_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorHocketReceivable"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorHocketPayment_receivableId_fkey'
      AND conrelid = 'kontor."KontorHocketPayment"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorHocketPayment"
      ADD CONSTRAINT "KontorHocketPayment_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorHocketReceivable"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorHocketCreditEntry_organizationCreditId_fkey'
      AND conrelid = 'kontor."KontorHocketCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorHocketCreditEntry"
      ADD CONSTRAINT "KontorHocketCreditEntry_organizationCreditId_fkey"
      FOREIGN KEY ("organizationCreditId") REFERENCES "kontor"."KontorHocketOrganizationCredit"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorHocketCreditEntry_receivableId_fkey'
      AND conrelid = 'kontor."KontorHocketCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorHocketCreditEntry"
      ADD CONSTRAINT "KontorHocketCreditEntry_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorHocketReceivable"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorHocketCreditEntry_paymentId_fkey'
      AND conrelid = 'kontor."KontorHocketCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorHocketCreditEntry"
      ADD CONSTRAINT "KontorHocketCreditEntry_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "kontor"."KontorHocketPayment"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$migration$;

ALTER TABLE "kontor"."KontorHocketReceivable" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorHocketSettlementOutbox" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorHocketPayment" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorHocketOrganizationCredit" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorHocketCreditEntry" OWNER TO "kontor_owner";

REVOKE ALL ON TABLE
  "kontor"."KontorHocketReceivable",
  "kontor"."KontorHocketSettlementOutbox",
  "kontor"."KontorHocketPayment",
  "kontor"."KontorHocketOrganizationCredit",
  "kontor"."KontorHocketCreditEntry"
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "kontor"."KontorHocketReceivable",
  "kontor"."KontorHocketSettlementOutbox",
  "kontor"."KontorHocketPayment",
  "kontor"."KontorHocketOrganizationCredit",
  "kontor"."KontorHocketCreditEntry"
TO "kontor_user";

DO $migration$
DECLARE
  invalid_detail TEXT;
BEGIN
  WITH expected(table_name) AS (
    VALUES
      ('KontorHocketReceivable'),
      ('KontorHocketSettlementOutbox'),
      ('KontorHocketPayment'),
      ('KontorHocketOrganizationCredit'),
      ('KontorHocketCreditEntry')
  )
  SELECT expected.table_name
  INTO invalid_detail
  FROM expected
  WHERE to_regclass(format('kontor.%I', expected.table_name)) IS NULL
  ORDER BY expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_KONTOR_BRIDGE_TABLE_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(table_name, column_name, type_name, not_null) AS (
    VALUES
      ('KontorHocketReceivable', 'receivableExternalId', 'text', TRUE),
      ('KontorHocketReceivable', 'eventId', 'text', TRUE),
      ('KontorHocketReceivable', 'settlementId', 'text', TRUE),
      ('KontorHocketReceivable', 'creditorOrganizationId', 'text', TRUE),
      ('KontorHocketReceivable', 'debtorOrganizationId', 'text', TRUE),
      ('KontorHocketReceivable', 'amountCents', 'integer', TRUE),
      ('KontorHocketReceivable', 'currency', 'text', TRUE),
      ('KontorHocketReceivable', 'snapshotHash', 'text', TRUE),
      ('KontorHocketReceivable', 'lineCount', 'integer', TRUE),
      ('KontorHocketReceivable', 'revision', 'integer', TRUE),
      ('KontorHocketReceivable', 'financeEntryId', 'text', TRUE),
      ('KontorHocketPayment', 'expectedRevision', 'integer', TRUE),
      ('KontorHocketPayment', 'evidenceReference', 'text', TRUE),
      ('KontorHocketOrganizationCredit', 'balanceCents', 'integer', TRUE),
      ('KontorHocketOrganizationCredit', 'revision', 'integer', TRUE)
  )
  SELECT format('%I.%I', expected.table_name, expected.column_name)
  INTO invalid_detail
  FROM expected
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'kontor'
    AND actual.table_name = expected.table_name
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.data_type IS DISTINCT FROM expected.type_name
    OR (actual.is_nullable = 'NO') IS DISTINCT FROM expected.not_null
  ORDER BY expected.table_name, expected.column_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_KONTOR_BRIDGE_COLUMN_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  SELECT table_record.relname
  INTO invalid_detail
  FROM pg_catalog.pg_class AS table_record
  INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_record.relnamespace
  WHERE namespace.nspname = 'kontor'
    AND table_record.relname IN (
      'KontorHocketReceivable',
      'KontorHocketSettlementOutbox',
      'KontorHocketPayment',
      'KontorHocketOrganizationCredit',
      'KontorHocketCreditEntry'
    )
    AND pg_catalog.pg_get_userbyid(table_record.relowner) IS DISTINCT FROM 'kontor_owner'
  ORDER BY table_record.relname
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_KONTOR_BRIDGE_OWNERSHIP_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(column_name, type_name, not_null, default_expression) AS (
    VALUES
      ('recordType', 'text', TRUE, '''LEGACY''::text'),
      ('tenantId', 'text', FALSE, NULL),
      ('eventId', 'text', FALSE, NULL)
  )
  SELECT expected.column_name
  INTO invalid_detail
  FROM expected
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'hocket'
    AND actual.table_name = 'HocketRecord'
    AND actual.column_name = expected.column_name
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = 'hocket."HocketRecord"'::pg_catalog.regclass
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef AS definition
    ON definition.adrelid = attribute.attrelid
    AND definition.adnum = attribute.attnum
  WHERE actual.column_name IS NULL
    OR actual.data_type IS DISTINCT FROM expected.type_name
    OR (actual.is_nullable = 'NO') IS DISTINCT FROM expected.not_null
    OR CASE
      WHEN expected.default_expression IS NULL THEN definition.oid IS NOT NULL
      ELSE definition.oid IS NULL
        OR pg_catalog.pg_get_expr(definition.adbin, definition.adrelid) IS DISTINCT FROM expected.default_expression
    END
  ORDER BY expected.column_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_RECORD_COLUMN_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_record
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = index_record.relnamespace
    WHERE namespace.nspname = 'hocket'
      AND index_record.relname = 'HocketRecord_recordType_tenantId_eventId_updatedAt_idx'
      AND index_record.relkind = 'i'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_RECORD_INDEX_CONTRACT_INVALID';
  END IF;

  IF pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class
     WHERE oid = 'hocket."HocketRecord"'::pg_catalog.regclass)
  ) IS DISTINCT FROM 'hocket_owner' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_RECORD_OWNERSHIP_CONTRACT_INVALID';
  END IF;

  IF NOT has_schema_privilege('hocket_user', 'hocket', 'USAGE')
    OR NOT has_table_privilege('hocket_user', 'hocket."HocketRecord"', 'SELECT')
    OR NOT has_table_privilege('hocket_user', 'hocket."HocketRecord"', 'INSERT')
    OR NOT has_table_privilege('hocket_user', 'hocket."HocketRecord"', 'UPDATE')
    OR NOT has_table_privilege('hocket_user', 'hocket."HocketRecord"', 'DELETE') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_HOCKET_RECORD_GRANT_CONTRACT_INVALID';
  END IF;
END
$migration$;
