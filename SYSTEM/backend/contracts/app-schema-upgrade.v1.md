# bonni.app-schema-upgrade/v1

The application owns its schema snapshot, source fingerprint, migration ID,
readiness anchors, obsolete-index rules and empty-reference transition rules.
The application manifest declares `metadata.database.schemaUpgrade` with this
schema ID, a relative JSON `file` below `database/`, and that file's SHA-256.
The application package and its existing module signature/labor authorization
remain authoritative for which source may be loaded.

Core resolves the owning module and data domain through the existing database
contract. It checks all files, hashes, source fingerprints and declarative DDL
before opening a database connection. It rejects linked/escaping files, raw
statements, executable defaults, protected domains and cross-schema references.
No app JavaScript migration or callback receives a privileged database client,
connection URL or credential.

Supported operations are additive enum labels/types, tables, columns and
indexes, exact FK validation/rule correction, declared empty-reference FK
transitions, and removal of exact obsolete unique indexes after their declared
replacement is verified. Existing incompatible columns and occupied reference
transitions stop the migration. Records are never deleted, nulled, copied or
reassigned by this protocol.

Core owns execution, domain-limited identifiers, transaction/lock boundaries,
timeouts, migration ledger verification and privacy-filtered technical errors.
Each migration has a descriptor hash in its domain-local `_BonniRuntimeMigration`
ledger. Older ledger entries remain intact. App changes need a new migration
identity; changing an already applied identity's descriptor is rejected.

Enum additions need an intermediate PostgreSQL commit before use. A session
advisory lock spans both phases. Empty-reference checks and FK replacement are
repeated under child-table write locks in the final transaction. A later error
rolls back table, column, index, constraint and ledger changes in that phase.
Already committed additive enum labels remain available for a safe retry.

The contract does not change runtime database privileges, Core/App finance
message contracts, UI routes, personal-data ownership or signed release rules.
