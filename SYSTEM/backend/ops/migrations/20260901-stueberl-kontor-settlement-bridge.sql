-- Bonni Core: persistente Stueberl/Kontor-Forderungs- und Settlement-Bruecke.
--
-- Der Ops-Runner besitzt die Transaktion. Die Migration ist wiederholbar und
-- qualifiziert jedes Objekt mit seinem fachlichen Datenschema. Sie loescht
-- weder Tabellen noch Zeilen. Zwei historische App-Migrationen werden hier
-- ebenfalls kontrolliert konvergiert: offene Terminal-Schluessel werden TEXT
-- und die beiden Stueberl-Schweregrade erhalten den app-eigenen Enum-Typ.

DO $migration$
DECLARE
  missing_contract TEXT;
BEGIN
  SELECT string_agg(required_object, ', ' ORDER BY required_object)
  INTO missing_contract
  FROM (
    VALUES
      ('schema:stueberl', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'stueberl')),
      ('schema:kontor', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'kontor')),
      ('role:stueberl_owner', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'stueberl_owner')),
      ('role:stueberl_user', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'stueberl_user')),
      ('role:kontor_owner', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kontor_owner')),
      ('role:kontor_user', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kontor_user'))
  ) AS required(required_object, present)
  WHERE NOT present;

  IF missing_contract IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_BASE_CONTRACT_INVALID',
      DETAIL = missing_contract;
  END IF;
END
$migration$;

-- Der alte Stueberl-Quellstand verwendete fuer diese Spalten implizit einen
-- fremden LogLevel. Der neue Typ bleibt absichtlich im Stueberl-Schema.
DO $migration$
DECLARE
  type_kind "char";
  invalid_label TEXT;
BEGIN
  SELECT enum_type.typtype
  INTO type_kind
  FROM pg_catalog.pg_type AS enum_type
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = enum_type.typnamespace
  WHERE namespace.nspname = 'stueberl'
    AND enum_type.typname = 'StueberlLogLevel';

  IF type_kind IS NULL THEN
    EXECUTE 'CREATE TYPE "stueberl"."StueberlLogLevel" AS ENUM (''DEBUG'', ''INFO'', ''WARN'', ''ERROR'', ''FATAL'')';
  ELSIF type_kind <> 'e' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_ENUM_CONTRACT_INVALID',
      DETAIL = 'stueberl.StueberlLogLevel is not an enum';
  END IF;

  SELECT expected.label
  INTO invalid_label
  FROM (VALUES ('DEBUG'), ('INFO'), ('WARN'), ('ERROR'), ('FATAL')) AS expected(label)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    INNER JOIN pg_catalog.pg_type AS enum_type
      ON enum_type.oid = enum_value.enumtypid
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = enum_type.typnamespace
    WHERE namespace.nspname = 'stueberl'
      AND enum_type.typname = 'StueberlLogLevel'
      AND enum_value.enumlabel = expected.label
  )
  ORDER BY expected.label
  LIMIT 1;

  IF invalid_label IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_ENUM_CONTRACT_INVALID',
      DETAIL = invalid_label;
  END IF;
END
$migration$;

ALTER TYPE "stueberl"."StueberlLogLevel" OWNER TO "stueberl_owner";

DO $migration$
DECLARE
  target RECORD;
  current_type OID;
  target_type CONSTANT OID := 'stueberl."StueberlLogLevel"'::pg_catalog.regtype;
  invalid_value TEXT;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('ContributionConflict', 'severity', TRUE),
      ('ReconciliationIssue', 'severity', FALSE)
    ) AS expected(table_name, column_name, has_warn_default)
  LOOP
    IF to_regclass(format('stueberl.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT attribute.atttypid
    INTO current_type
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = format('stueberl.%I', target.table_name)::pg_catalog.regclass
      AND attribute.attname = target.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF current_type IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_LOG_LEVEL_COLUMN_MISSING',
        DETAIL = format('stueberl.%I.%I', target.table_name, target.column_name);
    END IF;

    EXECUTE format(
      'SELECT %1$I::text FROM stueberl.%2$I WHERE %1$I IS NULL OR %1$I::text <> ALL (ARRAY[''DEBUG'', ''INFO'', ''WARN'', ''ERROR'', ''FATAL'']) LIMIT 1',
      target.column_name,
      target.table_name
    ) INTO invalid_value;
    IF invalid_value IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_LOG_LEVEL_VALUE_INVALID',
        DETAIL = format('stueberl.%I.%I=%s', target.table_name, target.column_name, invalid_value);
    END IF;

    IF current_type <> target_type THEN
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I DROP DEFAULT',
        target.table_name,
        target.column_name
      );
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I TYPE stueberl."StueberlLogLevel" USING %I::text::stueberl."StueberlLogLevel"',
        target.table_name,
        target.column_name,
        target.column_name
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE stueberl.%I ALTER COLUMN %I SET NOT NULL',
      target.table_name,
      target.column_name
    );
    IF target.has_warn_default THEN
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I SET DEFAULT ''WARN''::stueberl."StueberlLogLevel"',
        target.table_name,
        target.column_name
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I DROP DEFAULT',
        target.table_name,
        target.column_name
      );
    END IF;
  END LOOP;
END
$migration$;

-- Uebernahme der frueher nur app-lokal vorhandenen Terminal-Key-Migration.
DO $migration$
DECLARE
  target RECORD;
  current_type OID;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('LayoutPreset', 'terminalType'),
      ('ProductCategoryVisibility', 'terminalType'),
      ('ProductCategoryImage', 'terminalType'),
      ('ProductImage', 'terminalType')
    ) AS expected(table_name, column_name)
  LOOP
    IF to_regclass(format('stueberl.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT attribute.atttypid
    INTO current_type
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = format('stueberl.%I', target.table_name)::pg_catalog.regclass
      AND attribute.attname = target.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF current_type IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_TERMINAL_COLUMN_MISSING',
        DETAIL = format('stueberl.%I.%I', target.table_name, target.column_name);
    END IF;

    IF current_type <> 'pg_catalog.text'::pg_catalog.regtype THEN
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I DROP DEFAULT',
        target.table_name,
        target.column_name
      );
      EXECUTE format(
        'ALTER TABLE stueberl.%I ALTER COLUMN %I TYPE TEXT USING %I::text',
        target.table_name,
        target.column_name,
        target.column_name
      );
    END IF;
    EXECUTE format(
      'ALTER TABLE stueberl.%I ALTER COLUMN %I DROP DEFAULT, ALTER COLUMN %I DROP NOT NULL',
      target.table_name,
      target.column_name,
      target.column_name
    );
  END LOOP;
END
$migration$;

CREATE TABLE IF NOT EXISTS "stueberl"."StueberlKontorReceivable" (
  "id" TEXT NOT NULL,
  "receivableExternalId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "tabSessionId" TEXT NOT NULL,
  "tabSessionGroupId" TEXT NOT NULL,
  "financeSessionId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "description" TEXT NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "bookingCount" INTEGER NOT NULL,
  "releasedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RELEASED',
  "kontorReceivableId" TEXT,
  "receivedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "appliedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "openAmountCents" INTEGER NOT NULL,
  "creditGeneratedCents" INTEGER NOT NULL DEFAULT 0,
  "memberCreditBalanceCents" INTEGER NOT NULL DEFAULT 0,
  "memberCreditRevision" INTEGER NOT NULL DEFAULT 0,
  "settlementRevision" INTEGER NOT NULL DEFAULT 0,
  "settlementPayloadHash" TEXT,
  "lastPaymentMethod" TEXT,
  "lastPaymentExternalId" TEXT,
  "receivableMessageId" TEXT,
  "lastSettlementMessageId" TEXT,
  "lastSettlementAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StueberlKontorReceivable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stueberl"."StueberlKontorCashPayment" (
  "id" TEXT NOT NULL,
  "paymentExternalId" TEXT NOT NULL,
  "receivableExternalId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "paidAt" TIMESTAMP(3) NOT NULL,
  "messageId" TEXT,
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StueberlKontorCashPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stueberl"."StueberlKontorOutboxMessage" (
  "id" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "messageId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StueberlKontorOutboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stueberl"."StueberlKontorInboxMessage" (
  "messageId" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "receivableExternalId" TEXT NOT NULL,
  "settlementRevision" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StueberlKontorInboxMessage_pkey" PRIMARY KEY ("messageId")
);

CREATE TABLE IF NOT EXISTS "stueberl"."StueberlKontorMemberCredit" (
  "memberId" TEXT NOT NULL,
  "balanceCents" INTEGER NOT NULL DEFAULT 0,
  "memberCreditRevision" INTEGER NOT NULL DEFAULT 0,
  "settlementRevision" INTEGER NOT NULL DEFAULT 0,
  "kontorReceivableId" TEXT,
  "sourceMessageId" TEXT,
  "projectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StueberlKontorMemberCredit_pkey" PRIMARY KEY ("memberId")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlReceivable" (
  "id" TEXT NOT NULL,
  "receivableExternalId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "requestMessageId" TEXT,
  "requestPayloadHash" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "tabSessionGroupId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "description" TEXT NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "bookingCount" INTEGER NOT NULL,
  "releasedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "receivedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "appliedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "openAmountCents" INTEGER NOT NULL,
  "creditGeneratedCents" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastPaymentMethod" TEXT,
  "lastPaymentExternalId" TEXT,
  "subledgerId" TEXT NOT NULL,
  "subledgerItemId" TEXT NOT NULL,
  "financeEntryId" TEXT NOT NULL,
  "settlementMessageId" TEXT,
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KontorStueberlReceivable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlSettlementOutbox" (
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
  CONSTRAINT "KontorStueberlSettlementOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlPayment" (
  "id" TEXT NOT NULL,
  "paymentExternalId" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "sourceDomain" TEXT NOT NULL,
  "sourceModuleKey" TEXT NOT NULL,
  "requestMessageId" TEXT,
  "requestPayloadHash" TEXT NOT NULL,
  "httpIdempotencyKey" TEXT,
  "httpRequestHash" TEXT,
  "memberId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "method" TEXT NOT NULL,
  "providerReference" TEXT,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "appliedAmountCents" INTEGER NOT NULL,
  "creditGeneratedCents" INTEGER NOT NULL DEFAULT 0,
  "financePaymentAllocationId" TEXT,
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KontorStueberlPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlMemberCredit" (
  "memberId" TEXT NOT NULL,
  "balanceCents" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KontorStueberlMemberCredit_pkey" PRIMARY KEY ("memberId")
);

CREATE TABLE IF NOT EXISTS "kontor"."KontorStueberlCreditEntry" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "balanceAfterCents" INTEGER NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'OVERPAYMENT',
  "createdByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KontorStueberlCreditEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorReceivable_receivableExternalId_key" ON "stueberl"."StueberlKontorReceivable" ("receivableExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorReceivable_correlationId_key" ON "stueberl"."StueberlKontorReceivable" ("correlationId");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorReceivable_tabSessionId_key" ON "stueberl"."StueberlKontorReceivable" ("tabSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorReceivable_financeSessionId_key" ON "stueberl"."StueberlKontorReceivable" ("financeSessionId");
CREATE INDEX IF NOT EXISTS "StueberlKontorReceivable_memberId_status_idx" ON "stueberl"."StueberlKontorReceivable" ("memberId", "status");
CREATE INDEX IF NOT EXISTS "StueberlKontorReceivable_tabSessionGroupId_idx" ON "stueberl"."StueberlKontorReceivable" ("tabSessionGroupId");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorCashPayment_paymentExternalId_key" ON "stueberl"."StueberlKontorCashPayment" ("paymentExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorCashPayment_receivableExternalId_key" ON "stueberl"."StueberlKontorCashPayment" ("receivableExternalId");
CREATE INDEX IF NOT EXISTS "StueberlKontorCashPayment_memberId_paidAt_idx" ON "stueberl"."StueberlKontorCashPayment" ("memberId", "paidAt");
CREATE UNIQUE INDEX IF NOT EXISTS "StueberlKontorOutboxMessage_idempotencyKey_key" ON "stueberl"."StueberlKontorOutboxMessage" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS "StueberlKontorOutboxMessage_status_createdAt_idx" ON "stueberl"."StueberlKontorOutboxMessage" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "StueberlKontorOutboxMessage_correlationId_createdAt_idx" ON "stueberl"."StueberlKontorOutboxMessage" ("correlationId", "createdAt");
CREATE INDEX IF NOT EXISTS "StueberlKontorInboxMessage_receivableExternalId_settlementRevision_idx" ON "stueberl"."StueberlKontorInboxMessage" ("receivableExternalId", "settlementRevision");

CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlReceivable_receivableExternalId_key" ON "kontor"."KontorStueberlReceivable" ("receivableExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlReceivable_correlationId_key" ON "kontor"."KontorStueberlReceivable" ("correlationId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlReceivable_requestMessageId_key" ON "kontor"."KontorStueberlReceivable" ("requestMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlReceivable_subledgerItemId_key" ON "kontor"."KontorStueberlReceivable" ("subledgerItemId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlReceivable_financeEntryId_key" ON "kontor"."KontorStueberlReceivable" ("financeEntryId");
CREATE INDEX IF NOT EXISTS "KontorStueberlReceivable_memberId_status_idx" ON "kontor"."KontorStueberlReceivable" ("memberId", "status");
CREATE INDEX IF NOT EXISTS "KontorStueberlReceivable_status_releasedAt_idx" ON "kontor"."KontorStueberlReceivable" ("status", "releasedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlSettlementOutbox_idempotencyKey_key" ON "kontor"."KontorStueberlSettlementOutbox" ("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlSettlementOutbox_sourceRecordId_key" ON "kontor"."KontorStueberlSettlementOutbox" ("sourceRecordId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlSettlementOutbox_receivableId_revision_key" ON "kontor"."KontorStueberlSettlementOutbox" ("receivableId", "revision");
CREATE INDEX IF NOT EXISTS "KontorStueberlSettlementOutbox_status_createdAt_idx" ON "kontor"."KontorStueberlSettlementOutbox" ("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlPayment_paymentExternalId_key" ON "kontor"."KontorStueberlPayment" ("paymentExternalId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlPayment_requestMessageId_key" ON "kontor"."KontorStueberlPayment" ("requestMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlPayment_httpIdempotencyKey_key" ON "kontor"."KontorStueberlPayment" ("httpIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlPayment_providerReference_key" ON "kontor"."KontorStueberlPayment" ("providerReference");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlPayment_financePaymentAllocationId_key" ON "kontor"."KontorStueberlPayment" ("financePaymentAllocationId");
CREATE INDEX IF NOT EXISTS "KontorStueberlPayment_receivableId_paidAt_idx" ON "kontor"."KontorStueberlPayment" ("receivableId", "paidAt");
CREATE INDEX IF NOT EXISTS "KontorStueberlPayment_memberId_paidAt_idx" ON "kontor"."KontorStueberlPayment" ("memberId", "paidAt");
CREATE INDEX IF NOT EXISTS "KontorStueberlPayment_sourceDomain_paidAt_idx" ON "kontor"."KontorStueberlPayment" ("sourceDomain", "paidAt");
CREATE UNIQUE INDEX IF NOT EXISTS "KontorStueberlCreditEntry_paymentId_key" ON "kontor"."KontorStueberlCreditEntry" ("paymentId");
CREATE INDEX IF NOT EXISTS "KontorStueberlCreditEntry_memberId_createdAt_idx" ON "kontor"."KontorStueberlCreditEntry" ("memberId", "createdAt");
CREATE INDEX IF NOT EXISTS "KontorStueberlCreditEntry_receivableId_createdAt_idx" ON "kontor"."KontorStueberlCreditEntry" ("receivableId", "createdAt");

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorStueberlSettlementOutbox_receivableId_fkey'
      AND conrelid = 'kontor."KontorStueberlSettlementOutbox"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorStueberlSettlementOutbox"
      ADD CONSTRAINT "KontorStueberlSettlementOutbox_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorStueberlReceivable" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorStueberlPayment_receivableId_fkey'
      AND conrelid = 'kontor."KontorStueberlPayment"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorStueberlPayment"
      ADD CONSTRAINT "KontorStueberlPayment_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorStueberlReceivable" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorStueberlCreditEntry_memberId_fkey'
      AND conrelid = 'kontor."KontorStueberlCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorStueberlCreditEntry"
      ADD CONSTRAINT "KontorStueberlCreditEntry_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "kontor"."KontorStueberlMemberCredit" ("memberId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorStueberlCreditEntry_receivableId_fkey'
      AND conrelid = 'kontor."KontorStueberlCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorStueberlCreditEntry"
      ADD CONSTRAINT "KontorStueberlCreditEntry_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "kontor"."KontorStueberlReceivable" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'KontorStueberlCreditEntry_paymentId_fkey'
      AND conrelid = 'kontor."KontorStueberlCreditEntry"'::pg_catalog.regclass
  ) THEN
    ALTER TABLE "kontor"."KontorStueberlCreditEntry"
      ADD CONSTRAINT "KontorStueberlCreditEntry_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "kontor"."KontorStueberlPayment" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$migration$;

ALTER TABLE "stueberl"."StueberlKontorReceivable" OWNER TO "stueberl_owner";
ALTER TABLE "stueberl"."StueberlKontorCashPayment" OWNER TO "stueberl_owner";
ALTER TABLE "stueberl"."StueberlKontorOutboxMessage" OWNER TO "stueberl_owner";
ALTER TABLE "stueberl"."StueberlKontorInboxMessage" OWNER TO "stueberl_owner";
ALTER TABLE "stueberl"."StueberlKontorMemberCredit" OWNER TO "stueberl_owner";
ALTER TABLE "kontor"."KontorStueberlReceivable" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorStueberlSettlementOutbox" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorStueberlPayment" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorStueberlMemberCredit" OWNER TO "kontor_owner";
ALTER TABLE "kontor"."KontorStueberlCreditEntry" OWNER TO "kontor_owner";

REVOKE ALL ON TABLE
  "stueberl"."StueberlKontorReceivable",
  "stueberl"."StueberlKontorCashPayment",
  "stueberl"."StueberlKontorOutboxMessage",
  "stueberl"."StueberlKontorInboxMessage",
  "stueberl"."StueberlKontorMemberCredit"
FROM PUBLIC;
GRANT USAGE ON SCHEMA "stueberl" TO "stueberl_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "stueberl"."StueberlKontorReceivable",
  "stueberl"."StueberlKontorCashPayment",
  "stueberl"."StueberlKontorOutboxMessage",
  "stueberl"."StueberlKontorInboxMessage",
  "stueberl"."StueberlKontorMemberCredit"
TO "stueberl_user";

REVOKE ALL ON TABLE
  "kontor"."KontorStueberlReceivable",
  "kontor"."KontorStueberlSettlementOutbox",
  "kontor"."KontorStueberlPayment",
  "kontor"."KontorStueberlMemberCredit",
  "kontor"."KontorStueberlCreditEntry"
FROM PUBLIC;
GRANT USAGE ON SCHEMA "kontor" TO "kontor_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "kontor"."KontorStueberlReceivable",
  "kontor"."KontorStueberlSettlementOutbox",
  "kontor"."KontorStueberlPayment",
  "kontor"."KontorStueberlMemberCredit",
  "kontor"."KontorStueberlCreditEntry"
TO "kontor_user";

-- Abschliessende Katalogvertraege verhindern, dass ein gleichnamiges, aber
-- inkompatibles Bestandsobjekt still als erfolgreich migriert verbucht wird.
DO $migration$
DECLARE
  invalid_detail TEXT;
BEGIN
  WITH expected(schema_name, table_name) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable'),
      ('stueberl', 'StueberlKontorCashPayment'),
      ('stueberl', 'StueberlKontorOutboxMessage'),
      ('stueberl', 'StueberlKontorInboxMessage'),
      ('stueberl', 'StueberlKontorMemberCredit'),
      ('kontor', 'KontorStueberlReceivable'),
      ('kontor', 'KontorStueberlSettlementOutbox'),
      ('kontor', 'KontorStueberlPayment'),
      ('kontor', 'KontorStueberlMemberCredit'),
      ('kontor', 'KontorStueberlCreditEntry')
  )
  SELECT format('%I.%I', schema_name, table_name)
  INTO invalid_detail
  FROM expected
  WHERE to_regclass(format('%I.%I', schema_name, table_name)) IS NULL
  ORDER BY schema_name, table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_TABLE_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, column_name, type_name, not_null) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'id', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'receivableExternalId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'correlationId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'tabSessionId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'tabSessionGroupId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'financeSessionId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'memberId', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'amountCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'currency', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'description', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'snapshotHash', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'bookingCount', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'releasedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'status', 'text', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'kontorReceivableId', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'receivedAmountCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'appliedAmountCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'openAmountCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'creditGeneratedCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'memberCreditBalanceCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'memberCreditRevision', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'settlementRevision', 'integer', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'settlementPayloadHash', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'lastPaymentMethod', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'lastPaymentExternalId', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'receivableMessageId', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'lastSettlementMessageId', 'text', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'lastSettlementAt', 'timestamp without time zone', FALSE),
      ('stueberl', 'StueberlKontorReceivable', 'createdAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorReceivable', 'updatedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'id', 'text', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'paymentExternalId', 'text', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'receivableExternalId', 'text', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'memberId', 'text', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'amountCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'currency', 'text', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'paidAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'messageId', 'text', FALSE),
      ('stueberl', 'StueberlKontorCashPayment', 'createdByAccountId', 'text', FALSE),
      ('stueberl', 'StueberlKontorCashPayment', 'createdAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorCashPayment', 'updatedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'id', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'protocol', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'correlationId', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'idempotencyKey', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'sourceRecordId', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'payload', 'jsonb', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'status', 'text', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'messageId', 'text', FALSE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'attemptCount', 'integer', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'lastAttemptAt', 'timestamp without time zone', FALSE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'publishedAt', 'timestamp without time zone', FALSE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'lastErrorCode', 'text', FALSE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'createdAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorOutboxMessage', 'updatedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'messageId', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'protocol', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'correlationId', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'payloadHash', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'receivableExternalId', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'settlementRevision', 'integer', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'outcome', 'text', TRUE),
      ('stueberl', 'StueberlKontorInboxMessage', 'processedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'memberId', 'text', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'balanceCents', 'integer', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'memberCreditRevision', 'integer', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'settlementRevision', 'integer', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'kontorReceivableId', 'text', FALSE),
      ('stueberl', 'StueberlKontorMemberCredit', 'sourceMessageId', 'text', FALSE),
      ('stueberl', 'StueberlKontorMemberCredit', 'projectedAt', 'timestamp without time zone', TRUE),
      ('stueberl', 'StueberlKontorMemberCredit', 'updatedAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'id', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'receivableExternalId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'correlationId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'requestMessageId', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'requestPayloadHash', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'memberId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'tabSessionGroupId', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'amountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'currency', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'description', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'snapshotHash', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'bookingCount', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'releasedAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'status', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'receivedAmountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'appliedAmountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'openAmountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'creditGeneratedCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'revision', 'integer', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'lastPaymentMethod', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'lastPaymentExternalId', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'subledgerId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'subledgerItemId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'financeEntryId', 'text', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'settlementMessageId', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'createdByAccountId', 'text', FALSE),
      ('kontor', 'KontorStueberlReceivable', 'createdAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlReceivable', 'updatedAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'id', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'receivableId', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'revision', 'integer', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'correlationId', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'idempotencyKey', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'sourceRecordId', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'payload', 'jsonb', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'payloadHash', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'status', 'text', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'attemptCount', 'integer', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'lastAttemptAt', 'timestamp without time zone', FALSE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'lastError', 'text', FALSE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'messageId', 'text', FALSE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'publishedAt', 'timestamp without time zone', FALSE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'createdAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlSettlementOutbox', 'updatedAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlPayment', 'id', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'paymentExternalId', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'receivableId', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'correlationId', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'sourceDomain', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'sourceModuleKey', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'requestMessageId', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'requestPayloadHash', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'httpIdempotencyKey', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'httpRequestHash', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'memberId', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'amountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlPayment', 'currency', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'method', 'text', TRUE),
      ('kontor', 'KontorStueberlPayment', 'providerReference', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'paidAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlPayment', 'appliedAmountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlPayment', 'creditGeneratedCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlPayment', 'financePaymentAllocationId', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'createdByAccountId', 'text', FALSE),
      ('kontor', 'KontorStueberlPayment', 'createdAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlMemberCredit', 'memberId', 'text', TRUE),
      ('kontor', 'KontorStueberlMemberCredit', 'balanceCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlMemberCredit', 'revision', 'integer', TRUE),
      ('kontor', 'KontorStueberlMemberCredit', 'createdAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlMemberCredit', 'updatedAt', 'timestamp without time zone', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'id', 'text', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'memberId', 'text', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'receivableId', 'text', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'paymentId', 'text', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'amountCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'balanceAfterCents', 'integer', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'kind', 'text', TRUE),
      ('kontor', 'KontorStueberlCreditEntry', 'createdByAccountId', 'text', FALSE),
      ('kontor', 'KontorStueberlCreditEntry', 'createdAt', 'timestamp without time zone', TRUE)
  )
  SELECT format('%I.%I.%I', expected.schema_name, expected.table_name, expected.column_name)
  INTO invalid_detail
  FROM expected
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = expected.schema_name
    AND actual.table_name = expected.table_name
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.data_type IS DISTINCT FROM expected.type_name
    OR (actual.is_nullable = 'NO') IS DISTINCT FROM expected.not_null
    OR (expected.type_name = 'timestamp without time zone' AND actual.datetime_precision IS DISTINCT FROM 3)
  ORDER BY expected.schema_name, expected.table_name, expected.column_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_COLUMN_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, column_name, expected_default) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'currency', '''EUR''::text'),
      ('stueberl', 'StueberlKontorReceivable', 'status', '''RELEASED''::text'),
      ('stueberl', 'StueberlKontorReceivable', 'receivedAmountCents', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'appliedAmountCents', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'creditGeneratedCents', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'memberCreditBalanceCents', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'memberCreditRevision', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'settlementRevision', '0'),
      ('stueberl', 'StueberlKontorReceivable', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('stueberl', 'StueberlKontorCashPayment', 'currency', '''EUR''::text'),
      ('stueberl', 'StueberlKontorCashPayment', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'status', '''PENDING''::text'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'attemptCount', '0'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('stueberl', 'StueberlKontorInboxMessage', 'processedAt', 'CURRENT_TIMESTAMP'),
      ('stueberl', 'StueberlKontorMemberCredit', 'balanceCents', '0'),
      ('stueberl', 'StueberlKontorMemberCredit', 'memberCreditRevision', '0'),
      ('stueberl', 'StueberlKontorMemberCredit', 'settlementRevision', '0'),
      ('stueberl', 'StueberlKontorMemberCredit', 'projectedAt', 'CURRENT_TIMESTAMP'),
      ('kontor', 'KontorStueberlReceivable', 'currency', '''EUR''::text'),
      ('kontor', 'KontorStueberlReceivable', 'status', '''OPEN''::text'),
      ('kontor', 'KontorStueberlReceivable', 'receivedAmountCents', '0'),
      ('kontor', 'KontorStueberlReceivable', 'appliedAmountCents', '0'),
      ('kontor', 'KontorStueberlReceivable', 'creditGeneratedCents', '0'),
      ('kontor', 'KontorStueberlReceivable', 'revision', '1'),
      ('kontor', 'KontorStueberlReceivable', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'status', '''PENDING''::text'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'attemptCount', '0'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('kontor', 'KontorStueberlPayment', 'currency', '''EUR''::text'),
      ('kontor', 'KontorStueberlPayment', 'creditGeneratedCents', '0'),
      ('kontor', 'KontorStueberlPayment', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('kontor', 'KontorStueberlMemberCredit', 'balanceCents', '0'),
      ('kontor', 'KontorStueberlMemberCredit', 'revision', '1'),
      ('kontor', 'KontorStueberlMemberCredit', 'createdAt', 'CURRENT_TIMESTAMP'),
      ('kontor', 'KontorStueberlCreditEntry', 'kind', '''OVERPAYMENT''::text'),
      ('kontor', 'KontorStueberlCreditEntry', 'createdAt', 'CURRENT_TIMESTAMP')
  )
  SELECT format('%I.%I.%I', expected.schema_name, expected.table_name, expected.column_name)
  INTO invalid_detail
  FROM expected
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = expected.schema_name
    AND actual.table_name = expected.table_name
    AND actual.column_name = expected.column_name
  WHERE actual.column_default IS DISTINCT FROM expected.expected_default
  ORDER BY expected.schema_name, expected.table_name, expected.column_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_DEFAULT_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, constraint_name, column_name) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_pkey', 'id'),
      ('stueberl', 'StueberlKontorCashPayment', 'StueberlKontorCashPayment_pkey', 'id'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'StueberlKontorOutboxMessage_pkey', 'id'),
      ('stueberl', 'StueberlKontorInboxMessage', 'StueberlKontorInboxMessage_pkey', 'messageId'),
      ('stueberl', 'StueberlKontorMemberCredit', 'StueberlKontorMemberCredit_pkey', 'memberId'),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_pkey', 'id'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_pkey', 'id'),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_pkey', 'id'),
      ('kontor', 'KontorStueberlMemberCredit', 'KontorStueberlMemberCredit_pkey', 'memberId'),
      ('kontor', 'KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_pkey', 'id')
  )
  SELECT format('%I.%I.%I', expected.schema_name, expected.table_name, expected.constraint_name)
  INTO invalid_detail
  FROM expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_record
    INNER JOIN pg_catalog.pg_class AS table_record ON table_record.oid = constraint_record.conrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_record.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_record.oid AND attribute.attnum = constraint_record.conkey[1]
    WHERE namespace.nspname = expected.schema_name
      AND table_record.relname = expected.table_name
      AND constraint_record.conname = expected.constraint_name
      AND constraint_record.contype = 'p'
      AND cardinality(constraint_record.conkey) = 1
      AND attribute.attname = expected.column_name
  )
  ORDER BY expected.schema_name, expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_PRIMARY_KEY_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, index_name, unique_index, column_names) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_receivableExternalId_key', TRUE, ARRAY['receivableExternalId']::TEXT[]),
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_correlationId_key', TRUE, ARRAY['correlationId']::TEXT[]),
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_tabSessionId_key', TRUE, ARRAY['tabSessionId']::TEXT[]),
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_financeSessionId_key', TRUE, ARRAY['financeSessionId']::TEXT[]),
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_memberId_status_idx', FALSE, ARRAY['memberId', 'status']::TEXT[]),
      ('stueberl', 'StueberlKontorReceivable', 'StueberlKontorReceivable_tabSessionGroupId_idx', FALSE, ARRAY['tabSessionGroupId']::TEXT[]),
      ('stueberl', 'StueberlKontorCashPayment', 'StueberlKontorCashPayment_paymentExternalId_key', TRUE, ARRAY['paymentExternalId']::TEXT[]),
      ('stueberl', 'StueberlKontorCashPayment', 'StueberlKontorCashPayment_receivableExternalId_key', TRUE, ARRAY['receivableExternalId']::TEXT[]),
      ('stueberl', 'StueberlKontorCashPayment', 'StueberlKontorCashPayment_memberId_paidAt_idx', FALSE, ARRAY['memberId', 'paidAt']::TEXT[]),
      ('stueberl', 'StueberlKontorOutboxMessage', 'StueberlKontorOutboxMessage_idempotencyKey_key', TRUE, ARRAY['idempotencyKey']::TEXT[]),
      ('stueberl', 'StueberlKontorOutboxMessage', 'StueberlKontorOutboxMessage_status_createdAt_idx', FALSE, ARRAY['status', 'createdAt']::TEXT[]),
      ('stueberl', 'StueberlKontorOutboxMessage', 'StueberlKontorOutboxMessage_correlationId_createdAt_idx', FALSE, ARRAY['correlationId', 'createdAt']::TEXT[]),
      ('stueberl', 'StueberlKontorInboxMessage', 'StueberlKontorInboxMessage_receivableExternalId_settlementRevis', FALSE, ARRAY['receivableExternalId', 'settlementRevision']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_receivableExternalId_key', TRUE, ARRAY['receivableExternalId']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_correlationId_key', TRUE, ARRAY['correlationId']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_requestMessageId_key', TRUE, ARRAY['requestMessageId']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_subledgerItemId_key', TRUE, ARRAY['subledgerItemId']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_financeEntryId_key', TRUE, ARRAY['financeEntryId']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_memberId_status_idx', FALSE, ARRAY['memberId', 'status']::TEXT[]),
      ('kontor', 'KontorStueberlReceivable', 'KontorStueberlReceivable_status_releasedAt_idx', FALSE, ARRAY['status', 'releasedAt']::TEXT[]),
      ('kontor', 'KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_idempotencyKey_key', TRUE, ARRAY['idempotencyKey']::TEXT[]),
      ('kontor', 'KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_sourceRecordId_key', TRUE, ARRAY['sourceRecordId']::TEXT[]),
      ('kontor', 'KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_receivableId_revision_key', TRUE, ARRAY['receivableId', 'revision']::TEXT[]),
      ('kontor', 'KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_status_createdAt_idx', FALSE, ARRAY['status', 'createdAt']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_paymentExternalId_key', TRUE, ARRAY['paymentExternalId']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_requestMessageId_key', TRUE, ARRAY['requestMessageId']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_httpIdempotencyKey_key', TRUE, ARRAY['httpIdempotencyKey']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_providerReference_key', TRUE, ARRAY['providerReference']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_financePaymentAllocationId_key', TRUE, ARRAY['financePaymentAllocationId']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_receivableId_paidAt_idx', FALSE, ARRAY['receivableId', 'paidAt']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_memberId_paidAt_idx', FALSE, ARRAY['memberId', 'paidAt']::TEXT[]),
      ('kontor', 'KontorStueberlPayment', 'KontorStueberlPayment_sourceDomain_paidAt_idx', FALSE, ARRAY['sourceDomain', 'paidAt']::TEXT[]),
      ('kontor', 'KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_paymentId_key', TRUE, ARRAY['paymentId']::TEXT[]),
      ('kontor', 'KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_memberId_createdAt_idx', FALSE, ARRAY['memberId', 'createdAt']::TEXT[]),
      ('kontor', 'KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_receivableId_createdAt_idx', FALSE, ARRAY['receivableId', 'createdAt']::TEXT[])
  )
  SELECT expected.index_name
  INTO invalid_detail
  FROM expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_record
    INNER JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_record.relnamespace
    INNER JOIN pg_catalog.pg_index AS index_contract ON index_contract.indexrelid = index_record.oid
    INNER JOIN pg_catalog.pg_class AS table_record ON table_record.oid = index_contract.indrelid
    INNER JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_record.relnamespace
    WHERE index_namespace.nspname = expected.schema_name
      AND table_namespace.nspname = expected.schema_name
      AND index_record.relname = expected.index_name
      AND table_record.relname = expected.table_name
      AND index_contract.indisvalid
      AND index_contract.indisready
      AND index_contract.indisunique = expected.unique_index
      AND index_contract.indpred IS NULL
      AND index_contract.indexprs IS NULL
      AND ARRAY(
        SELECT attribute.attname::TEXT
        FROM unnest(index_contract.indkey::SMALLINT[]) WITH ORDINALITY AS key_column(attnum, position)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_contract.indrelid AND attribute.attnum = key_column.attnum
        WHERE key_column.position <= index_contract.indnkeyatts
        ORDER BY key_column.position
      ) = expected.column_names
  )
  ORDER BY expected.schema_name, expected.index_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_INDEX_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(table_name, constraint_name, referenced_table, column_name, referenced_column) AS (
    VALUES
      ('KontorStueberlSettlementOutbox', 'KontorStueberlSettlementOutbox_receivableId_fkey', 'KontorStueberlReceivable', 'receivableId', 'id'),
      ('KontorStueberlPayment', 'KontorStueberlPayment_receivableId_fkey', 'KontorStueberlReceivable', 'receivableId', 'id'),
      ('KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_memberId_fkey', 'KontorStueberlMemberCredit', 'memberId', 'memberId'),
      ('KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_receivableId_fkey', 'KontorStueberlReceivable', 'receivableId', 'id'),
      ('KontorStueberlCreditEntry', 'KontorStueberlCreditEntry_paymentId_fkey', 'KontorStueberlPayment', 'paymentId', 'id')
  )
  SELECT expected.constraint_name
  INTO invalid_detail
  FROM expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_record
    INNER JOIN pg_catalog.pg_class AS table_record ON table_record.oid = constraint_record.conrelid
    INNER JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_record.relnamespace
    INNER JOIN pg_catalog.pg_class AS referenced_table ON referenced_table.oid = constraint_record.confrelid
    INNER JOIN pg_catalog.pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS source_attribute
      ON source_attribute.attrelid = table_record.oid AND source_attribute.attnum = constraint_record.conkey[1]
    INNER JOIN pg_catalog.pg_attribute AS target_attribute
      ON target_attribute.attrelid = referenced_table.oid AND target_attribute.attnum = constraint_record.confkey[1]
    WHERE table_namespace.nspname = 'kontor'
      AND referenced_namespace.nspname = 'kontor'
      AND table_record.relname = expected.table_name
      AND referenced_table.relname = expected.referenced_table
      AND constraint_record.conname = expected.constraint_name
      AND constraint_record.contype = 'f'
      AND constraint_record.convalidated
      AND NOT constraint_record.condeferrable
      AND constraint_record.confdeltype = 'r'
      AND constraint_record.confupdtype = 'c'
      AND cardinality(constraint_record.conkey) = 1
      AND source_attribute.attname = expected.column_name
      AND target_attribute.attname = expected.referenced_column
  )
  ORDER BY expected.constraint_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_FOREIGN_KEY_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, owner_name, runtime_role) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'stueberl_owner', 'stueberl_user'),
      ('stueberl', 'StueberlKontorCashPayment', 'stueberl_owner', 'stueberl_user'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'stueberl_owner', 'stueberl_user'),
      ('stueberl', 'StueberlKontorInboxMessage', 'stueberl_owner', 'stueberl_user'),
      ('stueberl', 'StueberlKontorMemberCredit', 'stueberl_owner', 'stueberl_user'),
      ('kontor', 'KontorStueberlReceivable', 'kontor_owner', 'kontor_user'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'kontor_owner', 'kontor_user'),
      ('kontor', 'KontorStueberlPayment', 'kontor_owner', 'kontor_user'),
      ('kontor', 'KontorStueberlMemberCredit', 'kontor_owner', 'kontor_user'),
      ('kontor', 'KontorStueberlCreditEntry', 'kontor_owner', 'kontor_user')
  )
  SELECT format('%I.%I', expected.schema_name, expected.table_name)
  INTO invalid_detail
  FROM expected
  INNER JOIN pg_catalog.pg_class AS table_record ON table_record.relname = expected.table_name
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = table_record.relnamespace AND namespace.nspname = expected.schema_name
  WHERE pg_catalog.pg_get_userbyid(table_record.relowner) IS DISTINCT FROM expected.owner_name
  ORDER BY expected.schema_name, expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_OWNERSHIP_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  WITH expected(schema_name, table_name, runtime_role) AS (
    VALUES
      ('stueberl', 'StueberlKontorReceivable', 'stueberl_user'),
      ('stueberl', 'StueberlKontorCashPayment', 'stueberl_user'),
      ('stueberl', 'StueberlKontorOutboxMessage', 'stueberl_user'),
      ('stueberl', 'StueberlKontorInboxMessage', 'stueberl_user'),
      ('stueberl', 'StueberlKontorMemberCredit', 'stueberl_user'),
      ('kontor', 'KontorStueberlReceivable', 'kontor_user'),
      ('kontor', 'KontorStueberlSettlementOutbox', 'kontor_user'),
      ('kontor', 'KontorStueberlPayment', 'kontor_user'),
      ('kontor', 'KontorStueberlMemberCredit', 'kontor_user'),
      ('kontor', 'KontorStueberlCreditEntry', 'kontor_user')
  )
  SELECT format('%I.%I:%I', expected.schema_name, expected.table_name, expected.runtime_role)
  INTO invalid_detail
  FROM expected
  WHERE NOT has_schema_privilege(expected.runtime_role, expected.schema_name, 'USAGE')
    OR NOT has_table_privilege(expected.runtime_role, format('%I.%I', expected.schema_name, expected.table_name), 'SELECT')
    OR NOT has_table_privilege(expected.runtime_role, format('%I.%I', expected.schema_name, expected.table_name), 'INSERT')
    OR NOT has_table_privilege(expected.runtime_role, format('%I.%I', expected.schema_name, expected.table_name), 'UPDATE')
    OR NOT has_table_privilege(expected.runtime_role, format('%I.%I', expected.schema_name, expected.table_name), 'DELETE')
  ORDER BY expected.schema_name, expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_GRANT_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  SELECT format('stueberl.%I.%I', expected.table_name, expected.column_name)
  INTO invalid_detail
  FROM (VALUES
    ('ContributionConflict', 'severity', TRUE),
    ('ReconciliationIssue', 'severity', FALSE)
  ) AS expected(table_name, column_name, has_warn_default)
  INNER JOIN pg_catalog.pg_class AS table_record ON table_record.relname = expected.table_name
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = table_record.relnamespace AND namespace.nspname = 'stueberl'
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = table_record.oid
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef AS default_record
    ON default_record.adrelid = table_record.oid AND default_record.adnum = attribute.attnum
  WHERE attribute.atttypid IS DISTINCT FROM 'stueberl."StueberlLogLevel"'::pg_catalog.regtype
    OR NOT attribute.attnotnull
    OR (expected.has_warn_default AND pg_get_expr(default_record.adbin, default_record.adrelid) NOT LIKE '%WARN%')
    OR (NOT expected.has_warn_default AND default_record.oid IS NOT NULL)
  ORDER BY expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_LOG_LEVEL_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;

  SELECT format('stueberl.%I.%I', expected.table_name, expected.column_name)
  INTO invalid_detail
  FROM (VALUES
    ('LayoutPreset', 'terminalType'),
    ('ProductCategoryVisibility', 'terminalType'),
    ('ProductCategoryImage', 'terminalType'),
    ('ProductImage', 'terminalType')
  ) AS expected(table_name, column_name)
  INNER JOIN pg_catalog.pg_class AS table_record ON table_record.relname = expected.table_name
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = table_record.relnamespace AND namespace.nspname = 'stueberl'
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = table_record.oid
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  WHERE attribute.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype
    OR attribute.attnotnull
  ORDER BY expected.table_name
  LIMIT 1;
  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_STUEBERL_KONTOR_BRIDGE_TERMINAL_KEY_CONTRACT_INVALID', DETAIL = invalid_detail;
  END IF;
END
$migration$;
