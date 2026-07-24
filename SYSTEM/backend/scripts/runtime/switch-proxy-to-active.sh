#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

transaction_fence="$BONNI_HOST_ACTIVE_RELEASE_ROOT/update-transaction-fence.json"
if [ -e "$transaction_fence" ]; then
  echo "Proxy-Umschaltung verweigert: Ein Update-Transaktionszaun ist aktiv oder beschädigt." >&2
  exit 2
fi

export ACTIVE_BACKEND=backend-active
export ACTIVE_BACKEND_PORT=4000
export EMERGENCY_BACKEND=${EMERGENCY_BACKEND:-backend-emergency}
export EMERGENCY_BACKEND_PORT=${EMERGENCY_BACKEND_PORT:-4000}

docker compose --env-file "$BONNI_RUNTIME_ENV_FILE" --env-file "$BONNI_ACTIVE_RELEASE_ENV_FILE" \
  -f docker-compose.runtime.yml up -d --force-recreate runtime-proxy

echo "Proxy now points back to backend-active with backend-emergency as fallback."
