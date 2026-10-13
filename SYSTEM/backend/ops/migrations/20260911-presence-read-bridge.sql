-- Presence is separate from financial accounts, logins and stock.
CREATE TABLE IF NOT EXISTS "core"."SecurityMemberPresence" (
  "memberId" TEXT PRIMARY KEY REFERENCES "core"."MemberProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changedBy" TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3)
);
ALTER TABLE "core"."SecurityMemberPresence" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS "core"."SecurityPresenceObservation" (
  "id" TEXT PRIMARY KEY,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SecurityMemberPresence_status_idx" ON "core"."SecurityMemberPresence"("status");
CREATE TABLE IF NOT EXISTS "core"."SecurityPresenceBridge" (
  "id" TEXT PRIMARY KEY,
  "label" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'COUNT',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "SecurityPresenceBridge_tokenHash_key" ON "core"."SecurityPresenceBridge"("tokenHash");
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."SecurityMemberPresence", "core"."SecurityPresenceBridge", "core"."SecurityPresenceObservation" TO "core_user";
