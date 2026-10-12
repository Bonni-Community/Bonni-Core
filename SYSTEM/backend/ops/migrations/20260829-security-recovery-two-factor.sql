-- Bonni Core: versionierte Konvergenz des Security-Schemas von 0.1.19.
--
-- Die Prisma-Modelle fuer Recovery/2FA waren in 0.1.20a bereits enthalten,
-- eine bestehende 0.1.19-Datenbank erhielt die neuen Objekte jedoch nicht,
-- weil produktive Starts absichtlich kein `prisma db push` ausfuehren.
-- Diese Migration ist deshalb auf beiden gueltigen Ausgangszustaenden
-- wiederholbar: fehlende Erweiterungen werden angelegt, ein bereits durch
-- den initialen Bootstrap vollstaendiges 0.1.20a-Schema bleibt unveraendert.
--
-- Ausschliesslich expand-only: keine Tabelle, Spalte oder Zeile wird
-- geloescht, umbenannt oder in einen anderen Typ konvertiert. Der Ops-Runner
-- besitzt die Transaktion und schreibt den unveraenderlichen Datei-Hash erst
-- nach allen nachfolgenden Vertragspruefungen in sein Ledger.

DO $migration$
BEGIN
  IF to_regclass('core."Account"') IS NULL
    OR to_regclass('core."RefreshToken"') IS NULL
    OR to_regclass('core."Session"') IS NULL
    OR to_regclass('core."SecurityTwoFactorCredential"') IS NULL
    OR to_regclass('core."SecurityTwoFactorRecoveryCode"') IS NULL
    OR to_regclass('core."SecurityTwoFactorChallenge"') IS NULL
    OR to_regclass('privacy."ProtectedDataAccessGrant"') IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_BASE_CONTRACT_INVALID';
  END IF;

  IF to_regtype('core."SecurityTwoFactorChallengePurpose"') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_BASE_ENUM_MISSING';
  END IF;

  IF to_regtype('core."SecurityAccountRecoveryStatus"') IS NULL THEN
    CREATE TYPE "core"."SecurityAccountRecoveryStatus" AS ENUM (
      'PENDING',
      'LOCKED',
      'APPROVED',
      'CONSUMED',
      'EXPIRED',
      'CANCELLED'
    );
  END IF;

  IF to_regtype('core."SecurityAccountRecoveryDecisionValue"') IS NULL THEN
    CREATE TYPE "core"."SecurityAccountRecoveryDecisionValue" AS ENUM (
      'APPROVE',
      'REJECT'
    );
  END IF;

  IF to_regtype('core."SecurityTwoFactorEnrollmentStatus"') IS NULL THEN
    CREATE TYPE "core"."SecurityTwoFactorEnrollmentStatus" AS ENUM (
      'PENDING',
      'CLAIMED',
      'CONFIRMED',
      'EXPIRED',
      'FAILED',
      'REVOKED'
    );
  END IF;
END
$migration$;

ALTER TYPE "core"."SecurityTwoFactorChallengePurpose"
  ADD VALUE IF NOT EXISTS 'ACCOUNT_RECOVERY_APPROVAL';
ALTER TYPE "core"."SecurityTwoFactorChallengePurpose"
  ADD VALUE IF NOT EXISTS 'ACCOUNT_RECOVERY_SUPPORT_CODE';
ALTER TYPE "core"."SecurityTwoFactorChallengePurpose"
  ADD VALUE IF NOT EXISTS 'ACCOUNT_RECOVERY_POLICY';

ALTER TABLE "core"."Account"
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "passwordRecoveryLockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordRecoveryRequestId" TEXT,
  ADD COLUMN IF NOT EXISTS "privateDataTwoFactorEnrolledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "twoFactorEnrolledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "twoFactorProviderId" TEXT;

ALTER TABLE "core"."RefreshToken"
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "core"."Session"
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "mfaMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "mfaProviderId" TEXT,
  ADD COLUMN IF NOT EXISTS "mfaVerifiedAt" TIMESTAMP(3);

ALTER TABLE "core"."SecurityTwoFactorCredential"
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "enrollmentSlot" TEXT,
  ADD COLUMN IF NOT EXISTS "lastAcceptedTotpCounter" INTEGER;

ALTER TABLE "core"."SecurityTwoFactorRecoveryCode"
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "core"."SecurityTwoFactorChallenge"
  ADD COLUMN IF NOT EXISTS "accessScope" TEXT,
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "moduleKey" TEXT,
  ADD COLUMN IF NOT EXISTS "providerId" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS "subjectId" TEXT,
  ALTER COLUMN "maxAttempts" SET DEFAULT 8;

ALTER TABLE "privacy"."ProtectedDataAccessGrant"
  ADD COLUMN IF NOT EXISTS "accessScope" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "credentialRevision" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN IF NOT EXISTS "providerId" TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS "core"."SecurityAccountRecoveryRequest" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "status" "core"."SecurityAccountRecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "activeSlot" TEXT,
  "requestRevision" INTEGER NOT NULL DEFAULT 0,
  "targetCredentialRevision" INTEGER NOT NULL,
  "lockedCredentialRevision" INTEGER,
  "thresholdSnapshot" INTEGER NOT NULL,
  "policyRevisionSnapshot" INTEGER NOT NULL,
  "reviewerAccountIdsSnapshot" JSONB NOT NULL,
  "initiatedByAccountId" TEXT,
  "browserTokenHash" TEXT,
  "browserTokenExpiresAt" TIMESTAMP(3),
  "supportCodeHash" TEXT,
  "supportCodeExpiresAt" TIMESTAMP(3),
  "supportCodeIssuedAt" TIMESTAMP(3),
  "supportCodeUsedAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecurityAccountRecoveryRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityAccountRecoveryRequest_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "core"."Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "core"."SecurityAccountRecoveryDecision" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "approverAccountId" TEXT NOT NULL,
  "decision" "core"."SecurityAccountRecoveryDecisionValue" NOT NULL,
  "approverCredentialRevision" INTEGER NOT NULL,
  "providerId" TEXT NOT NULL,
  "challengeId" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SecurityAccountRecoveryDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityAccountRecoveryDecision_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "core"."SecurityAccountRecoveryRequest"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "core"."SecurityAccountRecoveryPolicy" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "reviewerAccountIds" JSONB NOT NULL,
  "threshold" INTEGER NOT NULL DEFAULT 3,
  "policyRevision" INTEGER NOT NULL DEFAULT 0,
  "updatedByAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecurityAccountRecoveryPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "core"."SecurityAccountRecoveryRateLimit" (
  "bucketKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecurityAccountRecoveryRateLimit_pkey" PRIMARY KEY ("bucketKey")
);

CREATE TABLE IF NOT EXISTS "core"."SecurityAccountRecoveryAuditLog" (
  "id" TEXT NOT NULL,
  "requestId" TEXT,
  "targetAccountId" TEXT,
  "actorAccountId" TEXT,
  "event" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SecurityAccountRecoveryAuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityAccountRecoveryAuditLog_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "core"."SecurityAccountRecoveryRequest"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "core"."SecurityTwoFactorEnrollment" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "requestedByAccountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL DEFAULT 'local',
  "enrollmentPasswordHash" TEXT,
  "status" "core"."SecurityTwoFactorEnrollmentStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "credentialRevision" INTEGER NOT NULL DEFAULT -1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecurityTwoFactorEnrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityTwoFactorEnrollment_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "core"."Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Falls ein voriger, nicht versionierter Testlauf die Tabellen ohne die
-- Prisma-Fremdschluessel angelegt hat, werden nur die fehlenden Constraints
-- ergaenzt. Gleichnamige vorhandene Constraints werden spaeter vollstaendig
-- auf Ziel, Spalten und Aktionen geprueft.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'SecurityAccountRecoveryRequest_accountId_fkey'
      AND conrelid = 'core."SecurityAccountRecoveryRequest"'::regclass
  ) THEN
    ALTER TABLE "core"."SecurityAccountRecoveryRequest"
      ADD CONSTRAINT "SecurityAccountRecoveryRequest_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "core"."Account"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'SecurityAccountRecoveryDecision_requestId_fkey'
      AND conrelid = 'core."SecurityAccountRecoveryDecision"'::regclass
  ) THEN
    ALTER TABLE "core"."SecurityAccountRecoveryDecision"
      ADD CONSTRAINT "SecurityAccountRecoveryDecision_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "core"."SecurityAccountRecoveryRequest"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'SecurityAccountRecoveryAuditLog_requestId_fkey'
      AND conrelid = 'core."SecurityAccountRecoveryAuditLog"'::regclass
  ) THEN
    ALTER TABLE "core"."SecurityAccountRecoveryAuditLog"
      ADD CONSTRAINT "SecurityAccountRecoveryAuditLog_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "core"."SecurityAccountRecoveryRequest"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'SecurityTwoFactorEnrollment_accountId_fkey'
      AND conrelid = 'core."SecurityTwoFactorEnrollment"'::regclass
  ) THEN
    ALTER TABLE "core"."SecurityTwoFactorEnrollment"
      ADD CONSTRAINT "SecurityTwoFactorEnrollment_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "core"."Account"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_reference_key"
  ON "core"."SecurityAccountRecoveryRequest"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_activeSlot_key"
  ON "core"."SecurityAccountRecoveryRequest"("activeSlot");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_browserTokenHash_key"
  ON "core"."SecurityAccountRecoveryRequest"("browserTokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_supportCodeHash_key"
  ON "core"."SecurityAccountRecoveryRequest"("supportCodeHash");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_accountId_status_idx"
  ON "core"."SecurityAccountRecoveryRequest"("accountId", "status");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_status_expiresAt_idx"
  ON "core"."SecurityAccountRecoveryRequest"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryRequest_initiatedByAccountId_created_idx"
  ON "core"."SecurityAccountRecoveryRequest"("initiatedByAccountId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryDecision_challengeId_key"
  ON "core"."SecurityAccountRecoveryDecision"("challengeId");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryDecision_requestId_decision_idx"
  ON "core"."SecurityAccountRecoveryDecision"("requestId", "decision");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryDecision_approverAccountId_decidedAt_idx"
  ON "core"."SecurityAccountRecoveryDecision"("approverAccountId", "decidedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAccountRecoveryDecision_requestId_approverAccountId_key"
  ON "core"."SecurityAccountRecoveryDecision"("requestId", "approverAccountId");

CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryRateLimit_windowStartedAt_idx"
  ON "core"."SecurityAccountRecoveryRateLimit"("windowStartedAt");

CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryAuditLog_requestId_createdAt_idx"
  ON "core"."SecurityAccountRecoveryAuditLog"("requestId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryAuditLog_targetAccountId_createdAt_idx"
  ON "core"."SecurityAccountRecoveryAuditLog"("targetAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryAuditLog_actorAccountId_createdAt_idx"
  ON "core"."SecurityAccountRecoveryAuditLog"("actorAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityAccountRecoveryAuditLog_event_createdAt_idx"
  ON "core"."SecurityAccountRecoveryAuditLog"("event", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "SecurityTwoFactorEnrollment_accountId_key"
  ON "core"."SecurityTwoFactorEnrollment"("accountId");
CREATE INDEX IF NOT EXISTS "SecurityTwoFactorEnrollment_requestedByAccountId_createdAt_idx"
  ON "core"."SecurityTwoFactorEnrollment"("requestedByAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityTwoFactorEnrollment_status_expiresAt_idx"
  ON "core"."SecurityTwoFactorEnrollment"("status", "expiresAt");

CREATE INDEX IF NOT EXISTS "Account_passwordRecoveryLockedAt_idx"
  ON "core"."Account"("passwordRecoveryLockedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityTwoFactorCredential_enrollmentSlot_key"
  ON "core"."SecurityTwoFactorCredential"("enrollmentSlot");

-- Vollstaendige additive Zielvertragspruefung. Zusaetzliche kuenftige
-- Spalten oder Enum-Werte bleiben erlaubt; jeder fuer 0.1.20c erforderliche
-- Typ, Default, Index und Fremdschluessel muss jedoch exakt vorhanden sein.
DO $migration$
DECLARE
  invalid_detail TEXT;
BEGIN
  WITH expected(
    table_name,
    column_name,
    data_type,
    udt_schema,
    udt_name,
    nullable,
    datetime_precision,
    has_default
  ) AS (
    VALUES
      ('Account', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('Account', 'passwordRecoveryLockedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('Account', 'passwordRecoveryRequestId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('Account', 'privateDataTwoFactorEnrolledAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('Account', 'twoFactorEnrolledAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('Account', 'twoFactorProviderId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('RefreshToken', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('Session', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('Session', 'mfaMethod', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('Session', 'mfaProviderId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('Session', 'mfaVerifiedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityTwoFactorCredential', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorCredential', 'enrollmentSlot', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorCredential', 'lastAcceptedTotpCounter', 'integer', 'pg_catalog', 'int4', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorRecoveryCode', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorChallenge', 'accessScope', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorChallenge', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorChallenge', 'moduleKey', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorChallenge', 'providerId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorChallenge', 'subjectId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorChallenge', 'maxAttempts', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),

      ('SecurityAccountRecoveryRequest', 'id', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'reference', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'accountId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'status', 'USER-DEFINED', 'core', 'SecurityAccountRecoveryStatus', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryRequest', 'activeSlot', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'requestRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryRequest', 'targetCredentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'lockedCredentialRevision', 'integer', 'pg_catalog', 'int4', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'thresholdSnapshot', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'policyRevisionSnapshot', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'reviewerAccountIdsSnapshot', 'jsonb', 'pg_catalog', 'jsonb', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'initiatedByAccountId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'browserTokenHash', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'browserTokenExpiresAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'supportCodeHash', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRequest', 'supportCodeExpiresAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'supportCodeIssuedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'supportCodeUsedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'lockedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'approvedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'consumedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'cancelledAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'expiresAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),
      ('SecurityAccountRecoveryRequest', 'createdAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, TRUE),
      ('SecurityAccountRecoveryRequest', 'updatedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),

      ('SecurityAccountRecoveryDecision', 'id', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'requestId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'approverAccountId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'decision', 'USER-DEFINED', 'core', 'SecurityAccountRecoveryDecisionValue', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'approverCredentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'providerId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'challengeId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryDecision', 'decidedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, TRUE),

      ('SecurityAccountRecoveryPolicy', 'id', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryPolicy', 'reviewerAccountIds', 'jsonb', 'pg_catalog', 'jsonb', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryPolicy', 'threshold', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryPolicy', 'policyRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryPolicy', 'updatedByAccountId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryPolicy', 'createdAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, TRUE),
      ('SecurityAccountRecoveryPolicy', 'updatedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),

      ('SecurityAccountRecoveryRateLimit', 'bucketKey', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryRateLimit', 'attempts', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityAccountRecoveryRateLimit', 'windowStartedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),
      ('SecurityAccountRecoveryRateLimit', 'updatedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),

      ('SecurityAccountRecoveryAuditLog', 'id', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'requestId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'targetAccountId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'actorAccountId', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'event', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'result', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'ipAddress', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'userAgent', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'metadataJson', 'jsonb', 'pg_catalog', 'jsonb', TRUE, NULL::INTEGER, FALSE),
      ('SecurityAccountRecoveryAuditLog', 'createdAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, TRUE),

      ('SecurityTwoFactorEnrollment', 'id', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorEnrollment', 'accountId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorEnrollment', 'requestedByAccountId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorEnrollment', 'providerId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorEnrollment', 'enrollmentPasswordHash', 'text', 'pg_catalog', 'text', TRUE, NULL::INTEGER, FALSE),
      ('SecurityTwoFactorEnrollment', 'status', 'USER-DEFINED', 'core', 'SecurityTwoFactorEnrollmentStatus', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorEnrollment', 'attempts', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorEnrollment', 'maxAttempts', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorEnrollment', 'credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('SecurityTwoFactorEnrollment', 'expiresAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE),
      ('SecurityTwoFactorEnrollment', 'claimedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityTwoFactorEnrollment', 'confirmedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityTwoFactorEnrollment', 'revokedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', TRUE, 3, FALSE),
      ('SecurityTwoFactorEnrollment', 'createdAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, TRUE),
      ('SecurityTwoFactorEnrollment', 'updatedAt', 'timestamp without time zone', 'pg_catalog', 'timestamp', FALSE, 3, FALSE)
  ), invalid AS (
    SELECT expected.table_name, expected.column_name
    FROM expected
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'core'
      AND actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
      OR actual.data_type IS DISTINCT FROM expected.data_type
      OR actual.udt_schema IS DISTINCT FROM expected.udt_schema
      OR actual.udt_name IS DISTINCT FROM expected.udt_name
      OR (actual.is_nullable = 'YES') IS DISTINCT FROM expected.nullable
      OR actual.datetime_precision IS DISTINCT FROM expected.datetime_precision
      OR (actual.column_default IS NOT NULL) IS DISTINCT FROM expected.has_default
    ORDER BY expected.table_name, expected.column_name
    LIMIT 1
  )
  SELECT format('%I.%I', table_name, column_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_COLUMN_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  -- ProtectedDataAccessGrant gehoert zur isolierten Privacy-Domaene. Die
  -- Migration laeuft zwar mit core als search_path, adressiert diese drei
  -- additiven Felder aber absichtlich vollqualifiziert im privacy-Schema.
  WITH expected(
    column_name,
    data_type,
    udt_schema,
    udt_name,
    nullable,
    datetime_precision,
    has_default
  ) AS (
    VALUES
      ('accessScope', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, TRUE),
      ('credentialRevision', 'integer', 'pg_catalog', 'int4', FALSE, NULL::INTEGER, TRUE),
      ('providerId', 'text', 'pg_catalog', 'text', FALSE, NULL::INTEGER, TRUE)
  ), invalid AS (
    SELECT expected.column_name
    FROM expected
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'privacy'
      AND actual.table_name = 'ProtectedDataAccessGrant'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
      OR actual.data_type IS DISTINCT FROM expected.data_type
      OR actual.udt_schema IS DISTINCT FROM expected.udt_schema
      OR actual.udt_name IS DISTINCT FROM expected.udt_name
      OR (actual.is_nullable = 'YES') IS DISTINCT FROM expected.nullable
      OR actual.datetime_precision IS DISTINCT FROM expected.datetime_precision
      OR (actual.column_default IS NOT NULL) IS DISTINCT FROM expected.has_default
    ORDER BY expected.column_name
    LIMIT 1
  )
  SELECT format('privacy.%I.%I', 'ProtectedDataAccessGrant', column_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_COLUMN_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(table_name, column_name, expected_default) AS (
    VALUES
      ('Account', 'credentialRevision', '0'),
      ('RefreshToken', 'credentialRevision', '-1'),
      ('Session', 'credentialRevision', '-1'),
      ('SecurityTwoFactorCredential', 'credentialRevision', '-1'),
      ('SecurityTwoFactorRecoveryCode', 'credentialRevision', '-1'),
      ('SecurityTwoFactorChallenge', 'credentialRevision', '-1'),
      ('SecurityTwoFactorChallenge', 'providerId', 'local'),
      ('SecurityTwoFactorChallenge', 'maxAttempts', '8'),
      ('SecurityAccountRecoveryRequest', 'status', 'pending'),
      ('SecurityAccountRecoveryRequest', 'requestRevision', '0'),
      ('SecurityAccountRecoveryRequest', 'createdAt', 'current_timestamp'),
      ('SecurityAccountRecoveryDecision', 'decidedAt', 'current_timestamp'),
      ('SecurityAccountRecoveryPolicy', 'id', 'default'),
      ('SecurityAccountRecoveryPolicy', 'threshold', '3'),
      ('SecurityAccountRecoveryPolicy', 'policyRevision', '0'),
      ('SecurityAccountRecoveryPolicy', 'createdAt', 'current_timestamp'),
      ('SecurityAccountRecoveryRateLimit', 'attempts', '0'),
      ('SecurityAccountRecoveryAuditLog', 'createdAt', 'current_timestamp'),
      ('SecurityTwoFactorEnrollment', 'providerId', 'local'),
      ('SecurityTwoFactorEnrollment', 'status', 'pending'),
      ('SecurityTwoFactorEnrollment', 'attempts', '0'),
      ('SecurityTwoFactorEnrollment', 'maxAttempts', '8'),
      ('SecurityTwoFactorEnrollment', 'credentialRevision', '-1'),
      ('SecurityTwoFactorEnrollment', 'createdAt', 'current_timestamp')
  ), invalid AS (
    SELECT expected.table_name, expected.column_name
    FROM expected
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'core'
      AND actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
    WHERE actual.column_default IS NULL
      OR lower(
        trim(BOTH '''' FROM trim(BOTH '()' FROM split_part(actual.column_default, '::', 1)))
      ) IS DISTINCT FROM expected.expected_default
    ORDER BY expected.table_name, expected.column_name
    LIMIT 1
  )
  SELECT format('%I.%I', table_name, column_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_DEFAULT_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(column_name, expected_default) AS (
    VALUES
      ('accessScope', 'legacy'),
      ('credentialRevision', '-1'),
      ('providerId', 'legacy')
  ), invalid AS (
    SELECT expected.column_name
    FROM expected
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'privacy'
      AND actual.table_name = 'ProtectedDataAccessGrant'
      AND actual.column_name = expected.column_name
    WHERE actual.column_default IS NULL
      OR lower(
        trim(BOTH '''' FROM trim(BOTH '()' FROM split_part(actual.column_default, '::', 1)))
      ) IS DISTINCT FROM expected.expected_default
    ORDER BY expected.column_name
    LIMIT 1
  )
  SELECT format('privacy.%I.%I', 'ProtectedDataAccessGrant', column_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_DEFAULT_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(type_name, enum_label) AS (
    VALUES
      ('SecurityAccountRecoveryStatus', 'PENDING'),
      ('SecurityAccountRecoveryStatus', 'LOCKED'),
      ('SecurityAccountRecoveryStatus', 'APPROVED'),
      ('SecurityAccountRecoveryStatus', 'CONSUMED'),
      ('SecurityAccountRecoveryStatus', 'EXPIRED'),
      ('SecurityAccountRecoveryStatus', 'CANCELLED'),
      ('SecurityAccountRecoveryDecisionValue', 'APPROVE'),
      ('SecurityAccountRecoveryDecisionValue', 'REJECT'),
      ('SecurityTwoFactorEnrollmentStatus', 'PENDING'),
      ('SecurityTwoFactorEnrollmentStatus', 'CLAIMED'),
      ('SecurityTwoFactorEnrollmentStatus', 'CONFIRMED'),
      ('SecurityTwoFactorEnrollmentStatus', 'EXPIRED'),
      ('SecurityTwoFactorEnrollmentStatus', 'FAILED'),
      ('SecurityTwoFactorEnrollmentStatus', 'REVOKED'),
      ('SecurityTwoFactorChallengePurpose', 'LOGIN'),
      ('SecurityTwoFactorChallengePurpose', 'SECURITY_SETTINGS'),
      ('SecurityTwoFactorChallengePurpose', 'ADMIN_ELEVATION'),
      ('SecurityTwoFactorChallengePurpose', 'DSGVO_SUBJECT_DATA_VIEW'),
      ('SecurityTwoFactorChallengePurpose', 'DSGVO_SUBJECT_DATA_EXPORT'),
      ('SecurityTwoFactorChallengePurpose', 'DSGVO_SUBJECT_DATA_DELETE'),
      ('SecurityTwoFactorChallengePurpose', 'DSGVO_DELETION_RULE_UPDATE'),
      ('SecurityTwoFactorChallengePurpose', 'MODULE_PRIVATE_DATA_ACCESS'),
      ('SecurityTwoFactorChallengePurpose', 'ACCOUNT_RECOVERY_APPROVAL'),
      ('SecurityTwoFactorChallengePurpose', 'ACCOUNT_RECOVERY_SUPPORT_CODE'),
      ('SecurityTwoFactorChallengePurpose', 'ACCOUNT_RECOVERY_POLICY')
  ), invalid AS (
    SELECT expected.type_name, expected.enum_label
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_enum AS enum_value
      INNER JOIN pg_catalog.pg_type AS enum_type
        ON enum_type.oid = enum_value.enumtypid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = enum_type.typnamespace
      WHERE namespace.nspname = 'core'
        AND enum_type.typname = expected.type_name
        AND enum_type.typtype = 'e'
        AND enum_value.enumlabel = expected.enum_label
    )
    ORDER BY expected.type_name, expected.enum_label
    LIMIT 1
  )
  SELECT format('%I.%s', type_name, enum_label)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_ENUM_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(table_name, constraint_name, column_names) AS (
    VALUES
      ('SecurityAccountRecoveryRequest', 'SecurityAccountRecoveryRequest_pkey', ARRAY['id']::TEXT[]),
      ('SecurityAccountRecoveryDecision', 'SecurityAccountRecoveryDecision_pkey', ARRAY['id']::TEXT[]),
      ('SecurityAccountRecoveryPolicy', 'SecurityAccountRecoveryPolicy_pkey', ARRAY['id']::TEXT[]),
      ('SecurityAccountRecoveryRateLimit', 'SecurityAccountRecoveryRateLimit_pkey', ARRAY['bucketKey']::TEXT[]),
      ('SecurityAccountRecoveryAuditLog', 'SecurityAccountRecoveryAuditLog_pkey', ARRAY['id']::TEXT[]),
      ('SecurityTwoFactorEnrollment', 'SecurityTwoFactorEnrollment_pkey', ARRAY['id']::TEXT[])
  ), invalid AS (
    SELECT expected.table_name, expected.constraint_name
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_record
      INNER JOIN pg_catalog.pg_class AS table_record
        ON table_record.oid = constraint_record.conrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = table_record.relnamespace
      WHERE namespace.nspname = 'core'
        AND table_record.relname = expected.table_name
        AND constraint_record.conname = expected.constraint_name
        AND constraint_record.contype = 'p'
        AND constraint_record.convalidated
        AND ARRAY(
          SELECT attribute.attname::TEXT
          FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = constraint_record.conrelid
            AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected.column_names
    )
    ORDER BY expected.table_name
    LIMIT 1
  )
  SELECT format('%I.%I', table_name, constraint_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_PRIMARY_KEY_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(
    table_name,
    constraint_name,
    column_names,
    referenced_table_name,
    referenced_column_names,
    delete_action,
    update_action
  ) AS (
    VALUES
      (
        'SecurityAccountRecoveryRequest',
        'SecurityAccountRecoveryRequest_accountId_fkey',
        ARRAY['accountId']::TEXT[],
        'Account',
        ARRAY['id']::TEXT[],
        'c'::"char",
        'c'::"char"
      ),
      (
        'SecurityAccountRecoveryDecision',
        'SecurityAccountRecoveryDecision_requestId_fkey',
        ARRAY['requestId']::TEXT[],
        'SecurityAccountRecoveryRequest',
        ARRAY['id']::TEXT[],
        'c'::"char",
        'c'::"char"
      ),
      (
        'SecurityAccountRecoveryAuditLog',
        'SecurityAccountRecoveryAuditLog_requestId_fkey',
        ARRAY['requestId']::TEXT[],
        'SecurityAccountRecoveryRequest',
        ARRAY['id']::TEXT[],
        'n'::"char",
        'c'::"char"
      ),
      (
        'SecurityTwoFactorEnrollment',
        'SecurityTwoFactorEnrollment_accountId_fkey',
        ARRAY['accountId']::TEXT[],
        'Account',
        ARRAY['id']::TEXT[],
        'c'::"char",
        'c'::"char"
      )
  ), invalid AS (
    SELECT expected.table_name, expected.constraint_name
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_record
      INNER JOIN pg_catalog.pg_class AS table_record
        ON table_record.oid = constraint_record.conrelid
      INNER JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_record.relnamespace
      INNER JOIN pg_catalog.pg_class AS referenced_table
        ON referenced_table.oid = constraint_record.confrelid
      INNER JOIN pg_catalog.pg_namespace AS referenced_namespace
        ON referenced_namespace.oid = referenced_table.relnamespace
      WHERE table_namespace.nspname = 'core'
        AND referenced_namespace.nspname = 'core'
        AND table_record.relname = expected.table_name
        AND referenced_table.relname = expected.referenced_table_name
        AND constraint_record.conname = expected.constraint_name
        AND constraint_record.contype = 'f'
        AND constraint_record.convalidated
        AND NOT constraint_record.condeferrable
        AND NOT constraint_record.condeferred
        AND constraint_record.confdeltype = expected.delete_action
        AND constraint_record.confupdtype = expected.update_action
        AND ARRAY(
          SELECT attribute.attname::TEXT
          FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = constraint_record.conrelid
            AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected.column_names
        AND ARRAY(
          SELECT attribute.attname::TEXT
          FROM unnest(constraint_record.confkey) WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = constraint_record.confrelid
            AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) = expected.referenced_column_names
    )
    ORDER BY expected.table_name
    LIMIT 1
  )
  SELECT format('%I.%I', table_name, constraint_name)
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_FOREIGN_KEY_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;

  WITH expected(index_name, table_name, unique_index, column_names) AS (
    VALUES
      ('SecurityAccountRecoveryRequest_reference_key', 'SecurityAccountRecoveryRequest', TRUE, ARRAY['reference']::TEXT[]),
      ('SecurityAccountRecoveryRequest_activeSlot_key', 'SecurityAccountRecoveryRequest', TRUE, ARRAY['activeSlot']::TEXT[]),
      ('SecurityAccountRecoveryRequest_browserTokenHash_key', 'SecurityAccountRecoveryRequest', TRUE, ARRAY['browserTokenHash']::TEXT[]),
      ('SecurityAccountRecoveryRequest_supportCodeHash_key', 'SecurityAccountRecoveryRequest', TRUE, ARRAY['supportCodeHash']::TEXT[]),
      ('SecurityAccountRecoveryRequest_accountId_status_idx', 'SecurityAccountRecoveryRequest', FALSE, ARRAY['accountId', 'status']::TEXT[]),
      ('SecurityAccountRecoveryRequest_status_expiresAt_idx', 'SecurityAccountRecoveryRequest', FALSE, ARRAY['status', 'expiresAt']::TEXT[]),
      ('SecurityAccountRecoveryRequest_initiatedByAccountId_created_idx', 'SecurityAccountRecoveryRequest', FALSE, ARRAY['initiatedByAccountId', 'createdAt']::TEXT[]),
      ('SecurityAccountRecoveryDecision_challengeId_key', 'SecurityAccountRecoveryDecision', TRUE, ARRAY['challengeId']::TEXT[]),
      ('SecurityAccountRecoveryDecision_requestId_decision_idx', 'SecurityAccountRecoveryDecision', FALSE, ARRAY['requestId', 'decision']::TEXT[]),
      ('SecurityAccountRecoveryDecision_approverAccountId_decidedAt_idx', 'SecurityAccountRecoveryDecision', FALSE, ARRAY['approverAccountId', 'decidedAt']::TEXT[]),
      ('SecurityAccountRecoveryDecision_requestId_approverAccountId_key', 'SecurityAccountRecoveryDecision', TRUE, ARRAY['requestId', 'approverAccountId']::TEXT[]),
      ('SecurityAccountRecoveryRateLimit_windowStartedAt_idx', 'SecurityAccountRecoveryRateLimit', FALSE, ARRAY['windowStartedAt']::TEXT[]),
      ('SecurityAccountRecoveryAuditLog_requestId_createdAt_idx', 'SecurityAccountRecoveryAuditLog', FALSE, ARRAY['requestId', 'createdAt']::TEXT[]),
      ('SecurityAccountRecoveryAuditLog_targetAccountId_createdAt_idx', 'SecurityAccountRecoveryAuditLog', FALSE, ARRAY['targetAccountId', 'createdAt']::TEXT[]),
      ('SecurityAccountRecoveryAuditLog_actorAccountId_createdAt_idx', 'SecurityAccountRecoveryAuditLog', FALSE, ARRAY['actorAccountId', 'createdAt']::TEXT[]),
      ('SecurityAccountRecoveryAuditLog_event_createdAt_idx', 'SecurityAccountRecoveryAuditLog', FALSE, ARRAY['event', 'createdAt']::TEXT[]),
      ('SecurityTwoFactorEnrollment_accountId_key', 'SecurityTwoFactorEnrollment', TRUE, ARRAY['accountId']::TEXT[]),
      ('SecurityTwoFactorEnrollment_requestedByAccountId_createdAt_idx', 'SecurityTwoFactorEnrollment', FALSE, ARRAY['requestedByAccountId', 'createdAt']::TEXT[]),
      ('SecurityTwoFactorEnrollment_status_expiresAt_idx', 'SecurityTwoFactorEnrollment', FALSE, ARRAY['status', 'expiresAt']::TEXT[]),
      ('Account_passwordRecoveryLockedAt_idx', 'Account', FALSE, ARRAY['passwordRecoveryLockedAt']::TEXT[]),
      ('SecurityTwoFactorCredential_enrollmentSlot_key', 'SecurityTwoFactorCredential', TRUE, ARRAY['enrollmentSlot']::TEXT[])
  ), invalid AS (
    SELECT expected.index_name
    FROM expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS index_record
      INNER JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_record.relnamespace
      INNER JOIN pg_catalog.pg_index AS index_contract
        ON index_contract.indexrelid = index_record.oid
      INNER JOIN pg_catalog.pg_class AS table_record
        ON table_record.oid = index_contract.indrelid
      INNER JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_record.relnamespace
      WHERE index_namespace.nspname = 'core'
        AND table_namespace.nspname = 'core'
        AND index_record.relname = expected.index_name
        AND table_record.relname = expected.table_name
        AND index_record.relkind = 'i'
        AND index_contract.indisvalid
        AND index_contract.indisready
        AND index_contract.indisunique = expected.unique_index
        AND index_contract.indpred IS NULL
        AND index_contract.indexprs IS NULL
        AND ARRAY(
          SELECT attribute.attname::TEXT
          FROM unnest(index_contract.indkey::SMALLINT[]) WITH ORDINALITY
            AS key_column(attnum, position)
          INNER JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_contract.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.position <= index_contract.indnkeyatts
          ORDER BY key_column.position
        ) = expected.column_names
    )
    ORDER BY expected.index_name
    LIMIT 1
  )
  SELECT index_name
  INTO invalid_detail
  FROM invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_SECURITY_RECOVERY_INDEX_CONTRACT_INVALID',
      DETAIL = invalid_detail;
  END IF;
END
$migration$;
