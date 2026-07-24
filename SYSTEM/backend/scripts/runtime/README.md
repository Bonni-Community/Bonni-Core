# Runtime scripts

These scripts are intentionally simple wrappers around `docker compose -f docker-compose.runtime.yml`.

- `start-runtime.sh` is the mandatory fail-closed boot entry point. It stops
  application slots, starts only PostgreSQL/initializers, drains the private
  update journal through a one-shot recovery gate and releases active,
  emergency, proxy and the update-runner daemon only after that gate succeeds.
- `start-candidate.sh` refreshes the isolated Candidate database/storage copy,
  applies only versioned migrations to that copy and starts the probe backend.
- `switch-proxy-to-candidate.sh` rejects unsafe direct switching; the external
  runner owns Candidate validation, promotion, persistence and rollback.
- `switch-proxy-to-active.sh` points the proxy back to the active backend.
- `stop-old-active.sh` stops the old active backend after a successful switch.

The emergency backend remains available as the stable rescue backend. It should only be updated after the configured hold period, currently 14 days.

Active, Emergency, Proxy and the runner deliberately use `restart: "no"`.
Docker therefore cannot reopen an unconfirmed release after a host/daemon
restart. The host service that starts Bonni Core must invoke
`npm run runtime:start`; if the gate fails, only PostgreSQL/initializers remain
available and the application ports stay closed. This reduced availability is
the intended safety behavior, not a Compose misconfiguration.

Active and Emergency no longer execute `prisma db push` when they start. The
dedicated `database-bootstrap` service may create a schema only when PostgreSQL
is genuinely empty. Production migrations are runner-controlled through the
one-shot `database-migrator` service.

Active, Emergency, database bootstrap and Candidate source-copy are image-only
services. `start-runtime.sh` builds the initial Active image only when its tag
does not exist and creates the initial Emergency tag only when that independent
tag is missing. Later starts therefore cannot rebuild old source files over an
image promoted by the update runner, and normal starts never advance Emergency.

The old production bind mounts remain the defaults:

- `../../runtime/storage`
- `../../runtime/archive/logs`
- `../../run_system`

They can be overridden with `BONNI_HOST_RUNTIME_ROOT` and
`BONNI_HOST_RUN_SYSTEM_ROOT`. Candidate data uses separate Compose volumes and
the internal `runtime_candidate` network.

All runtime wrappers resolve and export the absolute host project/runtime paths
before parsing Compose. The update runner mounts the project at the identical
absolute path because its Docker CLI talks to the host daemon. Production
storage is read-only in the runner. Backend and runner exchange signed requests
through separate inbox/outbox volumes; the runner-only journal and HMAC secret
use their own volumes outside production storage and its backups.

The runtime configuration file defaults to `System/backend/.env`, must exist as
a readable regular host file and is mounted read-only into the runner. On a new
installation it is atomically created with mode `0600` from `.env.example` when
missing; the subsequent fresh/existing preflight still decides whether secrets
may be generated. Every
runner-owned Compose call loads this base file first and the private Active
release overlay second, so database and application secrets cannot silently
fall back to Compose defaults during a recreate.

The restricted Active overlay is persisted under
`runtime/update-runner/active/active-release.env`. Only the runner mounts that
directory read-write; Backend has no access. Host start/recovery scripts load it
after the base environment, preserving the promoted image and version across
reboots. The initializer atomically migrates the former private-volume overlay
once when it is present and valid; after that the host overlay is the only
canonical Active-state file. Interrupted transactions are reconciled from the
runner journal, not from a second competing Active-state copy.

Before the first container start, `ensure-runtime-env.mjs` atomically creates or
replaces missing, too-short and recognizable placeholder values for
`MASTER_KEY`, `JWT_SECRET`, `POSTGRES_PASSWORD` and `SANDBOX_PASSWORD`. Values
are never printed, existing secure values remain unchanged and the file is set
to mode `0600`. Generation is permitted only for a demonstrably fresh runtime.
If a production database volume or stored runtime data already exists, unsafe
values fail closed so neither PostgreSQL credentials nor encrypted data are
silently rotated.

The same preflight persists a unique `COMPOSE_PROJECT_NAME` and project-scoped
Active/Emergency/Rollback image tags. Existing real project names are kept. If the old
project-scoped `postgres_data` volume is detected, its legacy project name is
preserved; ambiguous existing data stops with a migration message instead of
starting an empty second instance.

Release public keys live outside images under
`runtime/secrets/update/trusted-keys/<keyId>.pem` by default. The directory is
mounted read-only into Active, Emergency and the runner. An empty directory is
valid but fail-closed: status remains available while every signed installation
is rejected until the matching public Ed25519 key is provisioned.

Candidate volumes contain a temporary copy of potentially sensitive production
data. They carry `org.bonni.runtime.disposable=true`, are never published as a
host port and must be cleared/removed by the runner after a completed or failed
transaction. Never use `docker compose down -v` for that cleanup because it
would also remove the production `postgres_data` volume; target only the
explicitly labelled Candidate volumes.

`switch-proxy-to-active.sh` remains a manual recovery tool. A production update
must use the external runner because it persists and reconciles the complete
switch transaction.

The same directory contains the boot-visible transaction marker
`update-transaction-fence.json` while a production cutover is unfinished. A
present, malformed or unreconciled marker blocks boot. The runner stops Proxy,
Active, Emergency and all production helpers before it creates the final
PostgreSQL/`storage`/`run_system` snapshot. The marker preserves that write
fence across a process or host crash. The runner commits its private journal
and Active overlay before creating a recovered Active; the Active service has
no direct host port, so productive traffic can only be released through the
gated Proxy.

The production proxy is never connected to `runtime_candidate`. The runner
checks the Candidate from inside its container. During the short production
cutover the Proxy and both writable application slots remain stopped. Before a
durable target decision every failure restores the old image plus all three
data planes; after that decision rollback to old data is forbidden. Only a
healthy, reconciled Active is released through the Proxy again.

Emergency can read runner status but has neither the request HMAC key nor a
writable request inbox. It therefore cannot authorize or enqueue an update.
