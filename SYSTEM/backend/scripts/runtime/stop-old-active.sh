#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

docker compose --env-file "$BONNI_RUNTIME_ENV_FILE" --env-file "$BONNI_ACTIVE_RELEASE_ENV_FILE" \
  -f docker-compose.runtime.yml stop backend-active

echo "backend-active stopped. Keep its image/build available as previous rollback target."
