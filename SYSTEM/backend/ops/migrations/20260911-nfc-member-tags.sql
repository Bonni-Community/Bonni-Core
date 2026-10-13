-- Additive NFC registry; no financial account is created or required.
CREATE TABLE IF NOT EXISTS "core"."SecurityNfcTag" (
  "id" TEXT PRIMARY KEY,
  "memberId" TEXT NOT NULL REFERENCES "core"."MemberProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "loginAccountId" TEXT REFERENCES "core"."Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "codeHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'NFC',
  "label" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityNfcTag_codeHash_key" ON "core"."SecurityNfcTag"("codeHash");
CREATE INDEX IF NOT EXISTS "SecurityNfcTag_memberId_revokedAt_idx" ON "core"."SecurityNfcTag"("memberId", "revokedAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."SecurityNfcTag" TO "core_user";
