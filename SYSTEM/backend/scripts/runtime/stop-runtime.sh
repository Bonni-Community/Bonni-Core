#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

transaction_fence="$BONNI_HOST_ACTIVE_RELEASE_ROOT/update-transaction-fence.json"
if [ -e "$transaction_fence" ] || [ -L "$transaction_fence" ]; then
  echo "Runtime-Stopp verweigert: Update-Transaktionszaun ist vorhanden; Recovery muss zuerst abgeschlossen werden." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker mit Compose-Unterstützung ist für den Runtime-Stopp erforderlich." >&2
  exit 2
fi

compose=(
  docker compose
  --env-file "$BONNI_RUNTIME_ENV_FILE"
  --env-file "$BONNI_ACTIVE_RELEASE_ENV_FILE"
  -f docker-compose.runtime.yml
)

activation_receipt="$BONNI_HOST_PROJECT_ROOT/SYSTEM/.bonni-source-update/control-center/docker-runtime-activation.json"
activation_was_present=false
if [ -e "$activation_receipt" ] || [ -L "$activation_receipt" ]; then
  activation_was_present=true
fi
deactivation_identity="$(node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" \
  begin-deactivation "$BONNI_HOST_PROJECT_ROOT" "$$")"
IFS=$'\t' read -r deactivation_owner_pid deactivation_token <<< "$deactivation_identity"
if [[ ! "$deactivation_owner_pid" =~ ^[1-9][0-9]*$ ]] \
  || [[ ! "$deactivation_token" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo "Runtime-Stopp verweigert: Deaktivierungsbeleg ist ungültig." >&2
  exit 2
fi
deactivation_owned=true
release_deactivation_intent() {
  local original_status=$?
  local release_status=0
  if [ "${deactivation_owned:-false}" = true ]; then
    if [ "$activation_was_present" = true ] || [ "$original_status" -eq 0 ]; then
      if ! node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" end-deactivation \
        "$BONNI_HOST_PROJECT_ROOT" "$deactivation_owner_pid" "$deactivation_token"; then
        echo "Runtime-Deaktivierungssperre konnte nicht eigentumsgetreu freigegeben werden." >&2
        release_status=1
      fi
      deactivation_owned=false
    else
      echo "Runtime-Deaktivierung bleibt nach abgebrochener Crash-Recovery fail-closed gesperrt." >&2
    fi
  fi
  if [ "$original_status" -eq 0 ] && [ "$release_status" -ne 0 ]; then
    return "$release_status"
  fi
  return "$original_status"
}
trap release_deactivation_intent EXIT

run_private_deactivation_gate() {
  local runner_id
  if ! runner_id="$("${compose[@]}" --profile update ps --all --status running -q update-runner 2>/dev/null)"; then
    echo "Runtime-Stopp verweigert: Update-Runner-Status ist nicht zuverlässig lesbar." >&2
    return 2
  fi
  if [ -n "$runner_id" ]; then
    "${compose[@]}" --profile update exec -T update-runner \
      node /runner/SYSTEM/backend/ops/update-runner/run.mjs --runtime-deactivation-gate
  else
    "${compose[@]}" --profile update run --rm --no-deps \
      update-runner --runtime-deactivation-gate
  fi
}

# First prove the daemon is idle while the intent prevents any new claim. Then
# stop only that daemon and repeat the same private-state proof in a one-shot
# runner. No application/database service is touched before both proofs pass.
run_private_deactivation_gate
"${compose[@]}" --profile update stop update-runner
if ! runner_remaining="$("${compose[@]}" --profile update ps --all --status running -q update-runner 2>/dev/null)"; then
  echo "Runtime-Stopp verweigert: Update-Runner-Stopp konnte nicht bestätigt werden." >&2
  exit 2
fi
if [ -n "$runner_remaining" ]; then
  echo "Runtime-Stopp verweigert: Update-Runner läuft nach dem Stopp weiter." >&2
  exit 2
fi
run_private_deactivation_gate
if [ -e "$transaction_fence" ] || [ -L "$transaction_fence" ]; then
  echo "Runtime-Stopp verweigert: Update-Transaktionszaun erschien während der Deaktivierung." >&2
  exit 2
fi

services=(
  runtime-proxy backend-active backend-emergency update-runner update-secret-init
  database-bootstrap database-migrator
  update-snapshot-create update-snapshot-restore update-snapshot-cleanup
  backend-candidate candidate-bootstrap candidate-migrator db-candidate db
)

"${compose[@]}" --profile update stop "${services[@]}"
if ! running="$("${compose[@]}" --profile update ps --all --status running -q 2>/dev/null)"; then
  echo "Runtime-Stopp verweigert: laufende Compose-Dienste konnten nicht zuverlässig geprüft werden." >&2
  exit 2
fi
if [ -n "$running" ]; then
  echo "Runtime-Stopp verweigert: mindestens ein produktiver oder Update-Container läuft weiter." >&2
  exit 2
fi

# Active was still a request producer during the earlier quiescence proofs.
# Re-run the trusted private gate only after every API producer and helper is
# confirmed down, then recheck the host fence immediately before latch removal.
run_private_deactivation_gate
if [ -e "$transaction_fence" ] || [ -L "$transaction_fence" ]; then
  echo "Runtime-Stopp verweigert: Update-Transaktionszaun erschien nach dem finalen Privatstatus-Gate." >&2
  exit 2
fi

# The activation receipt is removed only after Compose and all fixed loopback
# endpoints independently prove that no supported runtime writer is alive.
node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" deactivate "$BONNI_HOST_PROJECT_ROOT" \
  "$deactivation_owner_pid" "$deactivation_token"
node "$SCRIPT_DIR/runtime-mode-exclusion.mjs" end-deactivation "$BONNI_HOST_PROJECT_ROOT" \
  "$deactivation_owner_pid" "$deactivation_token"
deactivation_owned=false
echo "Docker-Runtime vollständig gestoppt; lokaler Entwicklungsmodus darf wieder aktiviert werden."
