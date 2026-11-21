-- Preserve existing notifications and legacy acknowledgement timestamps.
-- The ops runner owns the transaction and ledger; no account or message reset.
CREATE TABLE IF NOT EXISTS "core"."NotificationRecipientState" (
  "notificationId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  CONSTRAINT "NotificationRecipientState_pkey" PRIMARY KEY ("notificationId", "accountId"),
  CONSTRAINT "NotificationRecipientState_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "core"."Notification"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "NotificationRecipientState_accountId_archivedAt_idx"
  ON "core"."NotificationRecipientState" ("accountId", "archivedAt");

-- Match the prepared Core ownership and runtime access contract. No new role
-- or elevated runtime privilege is introduced by this migration.
ALTER TABLE "core"."NotificationRecipientState" OWNER TO "core_owner";
REVOKE ALL ON "core"."NotificationRecipientState" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON "core"."NotificationRecipientState" TO "core_user";
