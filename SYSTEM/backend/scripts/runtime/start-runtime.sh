#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Supported modes are mutually exclusive. Acquire this host-side marker before
# host-path initialization, Docker inspection, database bootstrap or any other
# shared-runtime mutation. The local source Supervisor checks the same marker
# before and after acquiring its own singleton receipt, closing simultaneous
# start races in both directions.
EARLY_BACKEND_ROOT="$(cd "$ROOT_DIR" && pwd -P)"
EARLY_PROJECT_ROOT="${BONNI_HOST_PROJECT_ROOT:-$(cd "$EARLY_BACKEND_ROOT/../.." && pwd -P)}"
case "$EARLY_PROJECT_ROOT" in
  /*) ;;
  *) echo "BONNI_HOST_PROJECT_ROOT muss ein absoluter Hostpfad sein." >&2; exit 2 ;;
esac
activation_action=acquire
if [ -n "${BONNI_MANAGED_ACTIVATION_TOKEN:-}" ]; then activation_action=acquire-managed; fi
runtime_activation_token="$(node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" "$activation_action" "$EARLY_PROJECT_ROOT" "$$")"
runtime_activation_owned=true
runtime_shared_mutation_started=false
release_runtime_activation() {
  local original_status=$?
  local release_status=0
  if [ "${runtime_activation_owned:-false}" = true ]; then
    if [ "${runtime_shared_mutation_started:-false}" = true ]; then
      echo "Docker-Runtime-Aktivierung bleibt nach begonnenem Runtime-Aufbau fail-closed gesperrt; bitte runtime:stop verwenden." >&2
    else
      if ! node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" release \
        "$EARLY_PROJECT_ROOT" "$$" "$runtime_activation_token"; then
        echo "Docker-Runtime-Aktivierungssperre konnte nicht eigentumsgetreu freigegeben werden." >&2
        release_status=1
      fi
    fi
    runtime_activation_owned=false
  fi
  if [ "$original_status" -eq 0 ] && [ "$release_status" -ne 0 ]; then
    return "$release_status"
  fi
  return "$original_status"
}
trap release_runtime_activation EXIT

# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

# A legacy Supervisor does not know the new activation marker. Recheck after
# host-path setup and still before the first Docker/DB/runtime mutation.
node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" check "$BONNI_HOST_PROJECT_ROOT"

# Emergency receives only its immutable JSON runtime subtree. Keeping the
# production database-routing file outside this mount prevents a delayed old
# image from replacing the Compose-enforced read-only connection string.
mkdir -p "$BONNI_HOST_RUN_SYSTEM_ROOT/system/emergency" "$BONNI_HOST_PROJECT_ROOT/UPDATE/core/downloads"
for extension in app addons plugins bridges backend; do
  mkdir -p "$BONNI_HOST_RUN_SYSTEM_ROOT/extensions/$extension"
done

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

# A failed `volume inspect` is ambiguous: it can mean either "not found" or a
# daemon/permission/transport failure. Confirm absence with a second, exact
# read-only listing before treating a runtime as fresh. While this probe is in
# flight the activation receipt stays fail-closed; only a fully reliable fresh
# result makes an early failure releasable again.
probe_docker_volume() {
  local volume_name="$1"
  local listed
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    printf '%s\n' present
    return 0
  fi
  if ! listed="$(docker volume ls --quiet --filter "name=^${volume_name}$" 2>/dev/null)"; then
    echo "Docker-Volume-Status für $volume_name ist nicht zuverlässig lesbar." >&2
    return 2
  fi
  if [ -z "$listed" ]; then
    printf '%s\n' absent
    return 0
  fi
  echo "Docker-Volume $volume_name wird gelistet, konnte aber nicht geprüft werden." >&2
  return 2
}

runtime_shared_mutation_started=true
if ! postgres_volume_state="$(probe_docker_volume "${project_probe}_postgres_data")"; then
  exit 2
fi
if ! backend_volume_state="$(probe_docker_volume "${project_probe}_backend_storage")"; then
  exit 2
fi

existing_runtime=false
if [ "$postgres_volume_state" = present ]; then
  existing_runtime=true
fi
storage_has_data=false
for data_root in "$BONNI_HOST_RUNTIME_ROOT/storage"; do
  if [ -d "$data_root" ] && [ -n "$(find "$data_root" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    existing_runtime=true
    storage_has_data=true
  fi
done
if [ "$storage_has_data" = false ] && [ "$backend_volume_state" = present ]; then
  echo "Altes Docker-Volume ${project_probe}_backend_storage gefunden, aber der neue Bind-Storage ist leer." >&2
  echo "Start verweigert: persistenten Speicher zuerst kontrolliert nach $BONNI_HOST_RUNTIME_ROOT/storage migrieren." >&2
  exit 2
fi
if [ "$existing_runtime" = true ] && [ -z "$persisted_project" ] \
  && [ "$postgres_volume_state" != present ]; then
  echo "Bestehende Laufzeitdaten ohne eindeutig ermittelbaren COMPOSE_PROJECT_NAME gefunden." >&2
  echo "Bitte den bisherigen Projektnamen kontrolliert in $BONNI_RUNTIME_ENV_FILE eintragen." >&2
  exit 2
fi
if [ "$existing_runtime" = true ]; then
  # From here onward a failed restart may have stopped or changed an existing
  # production runtime. Keep the latch until runtime:stop proves it offline.
  runtime_shared_mutation_started=true
else
  # Both exact volume probes and the bind-storage inspection reliably proved a
  # fresh installation. Until the Compose stop/status boundary below, an early
  # validation failure may still release this newly-created receipt.
  runtime_shared_mutation_started=false
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
runtime_shared_mutation_started=true
if ! "${compose[@]}" --profile update stop \
  runtime-proxy backend-active backend-emergency backend-candidate update-runner database-bootstrap \
  database-migrator candidate-bootstrap candidate-migrator db-candidate \
  update-secret-init update-snapshot-create update-snapshot-restore update-snapshot-cleanup; then
  echo "Start verweigert: bestehende Runtime-Dienste konnten nicht zuverlässig gestoppt werden." >&2
  exit 2
fi
if ! running_writers="$("${compose[@]}" --profile update ps --all --status running -q \
  runtime-proxy backend-active backend-emergency backend-candidate update-runner database-bootstrap \
  database-migrator candidate-bootstrap candidate-migrator db-candidate \
  update-secret-init update-snapshot-create update-snapshot-restore update-snapshot-cleanup 2>/dev/null)"; then
  echo "Start verweigert: Status bestehender Runtime-Dienste ist nicht zuverlässig lesbar." >&2
  exit 2
fi
if [ -n "$running_writers" ]; then
  echo "Start verweigert: Produktionsschreiber oder Update-Helfer ließen sich nicht vollständig stoppen." >&2
  exit 2
fi
if [ "$existing_runtime" = false ]; then
  # A reliable empty Compose probe proves that an early failure before the
  # fresh database starts can still release this newly-created marker.
  runtime_shared_mutation_started=false
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
  if [ -n "${BONNI_INITIAL_IMAGE:-}" ]; then
    docker image inspect "$BONNI_INITIAL_IMAGE" >/dev/null
    docker image tag "$BONNI_INITIAL_IMAGE" "$SYSTEM_IMAGE"
  else
  echo "Initiales Bonni-Core-Image $SYSTEM_IMAGE wird gebaut."
  docker build \
    --file "$BONNI_HOST_PROJECT_ROOT/SYSTEM/backend/Dockerfile" \
    --tag "$SYSTEM_IMAGE" \
    --build-arg "BONNI_CORE_VERSION=${SYSTEM_VERSION:-0.1.20+h-DEV.43}" \
    --build-arg "BONNI_CORE_REVISION=${BONNI_CORE_REVISION:-unknown}" \
    "$BONNI_HOST_PROJECT_ROOT"
  fi
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
# Starting the production database is the first writer/orchestration boundary
# for a fresh installation. Every later failure must preserve the mode latch.
runtime_shared_mutation_started=true
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
start_runtime_service() {
  local service="$1"
  local status
  if "${compose[@]}" up -d --wait --wait-timeout "$runtime_wait_seconds" "$service"; then
    return 0
  else
    status=$?
  fi
  # The outer deployment controller otherwise shows only Compose's exit code.
  # Keep the original failure and emit bounded service logs before CI cleanup.
  # Never print compose config or inspect output containing environment secrets.
  echo "Runtime-Dienst $service konnte nicht gestartet werden. Letzte Protokollzeilen:" >&2
  timeout 15s "${compose[@]}" logs --no-color --tail 80 "$service" >&2 || true
  return "$status"
}
start_runtime_service backend-active
start_runtime_service backend-emergency
start_runtime_service runtime-proxy
"${compose[@]}" run --rm --no-deps update-runner --network-transport-gate=open
start_runtime_service update-runner

echo "Runtime started after recovery gate: proxy -> confirmed backend-active, emergency fallback available."
echo "Health: http://localhost:${BACKEND_PORT:-4000}/api/health/ready"
echo "Emergency direct: http://127.0.0.1:${BACKEND_EMERGENCY_DIRECT_PORT:-4199}/api/health/ready"
echo "Update runner: enabled (isolated IPC and private state volumes)"

# Persist the now-dead-owner receipt as a runtime-mode latch. The local source
# Supervisor must remain blocked even while a later release cutover has every
# application port intentionally closed. Only runtime:stop may remove it after
# proving all project containers and relevant loopback ports are offline.
runtime_activation_owned=false
