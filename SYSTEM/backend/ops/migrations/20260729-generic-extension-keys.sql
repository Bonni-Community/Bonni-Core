-- Bonni Core: app-unabhängige Schlüssel statt fest verdrahteter Fach-Enums.
-- Diese Migration löscht weder Tabellen noch Zeilen und verändert keine
-- Accounts, Personen, Passwörter, Profile oder Sessions.

BEGIN;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'MemberCapability'
      AND column_name = 'key'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE "MemberCapability"
      ALTER COLUMN "key" TYPE TEXT USING "key"::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Terminal'
      AND column_name = 'type'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE "Terminal"
      ALTER COLUMN "type" TYPE TEXT USING "type"::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'TerminalLayoutOverride'
      AND column_name = 'terminalType'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE "TerminalLayoutOverride"
      ALTER COLUMN "terminalType" TYPE TEXT USING "terminalType"::text;
  END IF;
END
$migration$;

COMMIT;
