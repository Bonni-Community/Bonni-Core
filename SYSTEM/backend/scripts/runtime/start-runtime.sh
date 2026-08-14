#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker mit Compose-Unterstützung ist für den Runtime-Start erforderlich." >&2
  exit 2
fi

persisted_project="$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*//p' "$BONNI_RUNTIME_ENV_FILE")"
case "$persisted_project" in
  \"*\") persisted_project="${persisted_project#\"}"; persisted_project="${persisted_project%\"}" ;;
  \'*\') persisted_project="${persisted_project#\'}"; persisted_project="${persisted_project%\'}" ;;
esac
if [ -n "$persisted_project" ] && [[ ! "$persisted_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "Persistierter COMPOSE_PROJECT_NAME ist ungültig oder mehrfach vorhanden." >&2
  exit 2
fi

legacy_project="${BONNI_BACKEND_ROOT##*/}"
legacy_project="${legacy_project,,}"
legacy_project="${legacy_project//[^a-z0-9_-]/-}"
if [[ ! "$legacy_project" =~ ^[a-z0-9] ]]; then legacy_project="bonni-$legacy_project"; fi
legacy_project="${legacy_project:0:63}"
project_probe="${persisted_project:-$legacy_project}"

existing_runtime=false
if docker volume inspect "${project_probe}_postgres_data" >/dev/null 2>&1; then
  existing_runtime=true
fi
storage_has_data=false
for data_root in "$BONNI_HOST_RUNTIME_ROOT/storage"; do
  if [ -d "$data_root" ] && [ -n "$(find "$data_root" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    existing_runtime=true
    storage_has_data=true
  fi
done
if [ "$storage_has_data" = false ] \
  && docker volume inspect "${project_probe}_backend_storage" >/dev/null 2>&1; then
  echo "Altes Docker-Volume ${project_probe}_backend_storage gefunden, aber der neue Bind-Storage ist leer." >&2
  echo "Start verweigert: persistenten Speicher zuerst kontrolliert nach $BONNI_HOST_RUNTIME_ROOT/storage migrieren." >&2
  exit 2
fi
if [ "$existing_runtime" = true ] && [ -z "$persisted_project" ] \
  && ! docker volume inspect "${legacy_project}_postgres_data" >/dev/null 2>&1; then
  echo "Bestehende Laufzeitdaten ohne eindeutig ermittelbaren COMPOSE_PROJECT_NAME gefunden." >&2
  echo "Bitte den bisherigen Projektnamen kontrolliert in $BONNI_RUNTIME_ENV_FILE eintragen." >&2
  exit 2
fi

preflight_mode=--fresh
project_argument=()
if [ "$existing_runtime" = true ]; then
  preflight_mode=--existing
  if [ -z "$persisted_project" ]; then project_argument=("--project-name=$legacy_project"); fi
fi
runtime_identifiers="$(node "$SCRIPT_DIR/ensure-runtime-env.mjs" "$BONNI_RUNTIME_ENV_FILE" "$preflight_mode" "${project_argument[@]}" --identifiers)"
IFS=$'\t' read -r configured_project configured_active_image configured_emergency_image configured_rollback_image <<< "$runtime_identifiers"
if [ -z "$configured_project" ] || [ -z "$configured_active_image" ] \
  || [ -z "$configured_emergency_image" ] || [ -z "$configured_rollback_image" ]; then
  echo "Persistente Runtime-Identität konnte nicht eingerichtet werden." >&2
  exit 2
fi
export COMPOSE_PROJECT_NAME="$configured_project"
export BONNI_ACTIVE_IMAGE_TAG="$configured_active_image"
export BONNI_EMERGENCY_IMAGE_TAG="$configured_emergency_image"
export BONNI_ROLLBACK_IMAGE_TAG="$configured_rollback_image"

SYSTEM_IMAGE="${SYSTEM_IMAGE:-$BONNI_ACTIVE_IMAGE_TAG}"
EMERGENCY_SYSTEM_IMAGE="${EMERGENCY_SYSTEM_IMAGE:-$BONNI_EMERGENCY_IMAGE_TAG}"
export SYSTEM_IMAGE EMERGENCY_SYSTEM_IMAGE

compose=(
  docker compose
  --env-file "$BONNI_RUNTIME_ENV_FILE"
  --env-file "$BONNI_ACTIVE_RELEASE_ENV_FILE"
  -f docker-compose.runtime.yml
)
runtime_wait_seconds="${BONNI_RUNTIME_WAIT_SECONDS:-180}"
if [[ ! "$runtime_wait_seconds" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "BONNI_RUNTIME_WAIT_SECONDS muss eine positive Ganzzahl mit höchstens vier Stellen sein." >&2
  exit 2
fi

# Stop potentially legacy auto-restarting containers as soon as the immutable
# instance identity is known. No application process may outlive this point and
# race the private update journal during the rest of the boot preflight.
"${compose[@]}" --profile update stop \
  runtime-proxy backend-active backend-emergency update-runner database-bootstrap \
  database-migrator update-snapshot-create update-snapshot-restore >/dev/null 2>&1 || true
running_writers="$("${compose[@]}" --profile update ps --all --status running -q \
  runtime-proxy backend-active backend-emergency update-runner database-bootstrap \
  database-migrator update-snapshot-create update-snapshot-restore 2>/dev/null || true)"
if [ -n "$running_writers" ]; then
  echo "Start verweigert: Produktionsschreiber oder Update-Helfer ließen sich nicht vollständig stoppen." >&2
  exit 2
fi

if [ "$existing_runtime" = true ] && ! docker image inspect "$SYSTEM_IMAGE" >/dev/null 2>&1; then
  legacy_containers="$(docker ps -aq \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.service=backend" 2>/dev/null || true)"
  if [[ "$legacy_containers" =~ ^[A-Za-z0-9_.-]{3,128}$ ]]; then
    legacy_image="$(docker inspect --format '{{.Image}}' "$legacy_containers" 2>/dev/null || true)"
    if [[ "$legacy_image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      docker image tag "$legacy_image" "$SYSTEM_IMAGE"
    fi
  fi
fi
if [ "$existing_runtime" = true ] && ! docker image inspect "$SYSTEM_IMAGE" >/dev/null 2>&1; then
  echo "Bestehende Installation besitzt kein eindeutig migrierbares Active-Image; lokaler Neubau wurde verweigert." >&2
  exit 2
fi
if [ "$existing_runtime" = true ] && ! docker image inspect "$EMERGENCY_SYSTEM_IMAGE" >/dev/null 2>&1; then
  docker image tag "$SYSTEM_IMAGE" "$EMERGENCY_SYSTEM_IMAGE"
fi

# Runtime slots are image-only so a later Compose invocation cannot rebuild an
# old source tree over a release promoted by the update runner. Only a genuinely
# new installation receives this one-time local bootstrap image.
if ! docker image inspect "$SYSTEM_IMAGE" >/dev/null 2>&1; then
  echo "Initiales Bonni-Core-Image $SYSTEM_IMAGE wird gebaut."
  docker build \
    --file "$BONNI_HOST_PROJECT_ROOT/System/backend/Dockerfile" \
    --tag "$SYSTEM_IMAGE" \
    --build-arg "BONNI_CORE_VERSION=${SYSTEM_VERSION:-0.1.19}" \
    --build-arg "BONNI_CORE_REVISION=${BONNI_CORE_REVISION:-unknown}" \
    "$BONNI_HOST_PROJECT_ROOT"
fi

# Emergency is deliberately pinned independently. Once present, normal starts
# never move this tag; only the controlled hold-period flow may replace it.
if ! docker image inspect "$EMERGENCY_SYSTEM_IMAGE" >/dev/null 2>&1; then
  echo "Initiales Emergency-Image $EMERGENCY_SYSTEM_IMAGE wird angelegt."
  docker image tag "$SYSTEM_IMAGE" "$EMERGENCY_SYSTEM_IMAGE"
fi

# This is the boot safety boundary. Old containers may still carry an earlier
# `unless-stopped` policy, so they were stopped above before image preparation.
# From there until the gate succeeds the public and Emergency ports stay closed
# and no production application process can run ahead of its transaction journal.

# Run the idempotent initializer once before later Compose invocations read the
# Active overlay. It also performs the one-time migration from the former
# runner-private overlay without granting Backend access to either location.
"${compose[@]}" run --rm --no-deps update-secret-init

# A previous clean shutdown may have left a positive transport grant in the
# shared runner outbox. No application starts until the trusted runner removes
# it. Missing/invalid grants are deliberately treated as closed by Network.
"${compose[@]}" run --rm --no-deps update-runner --network-transport-gate=close

# Only PostgreSQL is allowed before reconciliation. The target database may be
# temporarily absent after a crash between exact drop/recreate restore steps;
# therefore database-bootstrap must run only after the boot gate repaired it.
"${compose[@]}" up -d db
"${compose[@]}" up -d --wait --wait-timeout "$runtime_wait_seconds" db

# A single runner invocation owns boot recovery. --boot-gate is fail closed:
# busy, failed, orphaned-fence or unreconciled journal states return non-zero.
# If an interrupted transaction needs container probes, they remain part of
# that gated runner transaction; this script never releases around the gate.
"${compose[@]}" run --rm --no-deps \
  -e BONNI_UPDATE_BOOT_RECOVERY=true \
  update-runner --once --boot-gate

transaction_fence="$BONNI_HOST_ACTIVE_RELEASE_ROOT/update-transaction-fence.json"
if [ -e "$transaction_fence" ]; then
  echo "Start verweigert: Update-Transaktionszaun ist nach der Recovery noch vorhanden." >&2
  exit 2
fi

# With the target database reconciled, canonical empty-install initialization
# may run. It never mutates an existing installation.
"${compose[@]}" up -d --force-recreate update-secret-init database-bootstrap
"${compose[@]}" wait update-secret-init database-bootstrap

# The canonical overlay and transaction fence are now reconciled. Start and
# validate only confirmed application slots, then open the public Proxy, then
# enter normal runner daemon mode.
"${compose[@]}" up -d --wait --wait-timeout "$runtime_wait_seconds" backend-active
"${compose[@]}" up -d --wait --wait-timeout "$runtime_wait_seconds" backend-emergency
"${compose[@]}" up -d --wait --wait-timeout "$runtime_wait_seconds" runtime-proxy
"${compose[@]}" run --rm --no-deps update-runner --network-transport-gate=open
"${compose[@]}" up -d update-runner

echo "Runtime started after recovery gate: proxy -> confirmed backend-active, emergency fallback available."
echo "Health: http://localhost:${BACKEND_PORT:-4000}/api/health/ready"
echo "Emergency direct: http://127.0.0.1:${BACKEND_EMERGENCY_DIRECT_PORT:-4199}/api/health/ready"
echo "Update runner: enabled (isolated IPC and private state volumes)"
