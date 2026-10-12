-- Bonni Core: zweiter Vorname als eigenständiges, optionales Person-Feld.
-- Expand-only und rückwärtskompatibel: die vorherige Anwendungsversion
-- ignoriert die neue nullable Spalte. Bestehende kombinierte Vornamen werden
-- absichtlich nicht heuristisch getrennt.
--
-- Der kontrollierte Ops-Migrationsrunner führt diese Anweisung atomar aus und
-- wendet sie auf der normalen sowie, falls vorhanden, auf der kanonischen
-- redundanten Bonni-Core-Datenbank an.

ALTER TABLE "core"."Person"
  ADD COLUMN IF NOT EXISTS "secondFirstName" TEXT;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    INNER JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'core'
      AND relation.relname = 'Person'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attname = 'secondFirstName'
      AND attribute.attnum > 0
      AND attribute.attisdropped = FALSE
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.atttypmod = -1
      AND attribute.attnotnull = FALSE
      AND attribute.atthasdef = FALSE
      AND attribute.attgenerated = ''
      AND attribute.attidentity = ''
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'BONNI_OPS_PERSON_SECOND_FIRST_NAME_CONTRACT_INVALID';
  END IF;
END
$migration$;
