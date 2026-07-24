#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=host-paths.sh
source "$SCRIPT_DIR/host-paths.sh"
bonni_runtime_export_host_paths "$ROOT_DIR"
cd "$BONNI_BACKEND_ROOT"

docker compose --env-file "$BONNI_RUNTIME_ENV_FILE" --env-file "$BONNI_ACTIVE_RELEASE_ENV_FILE" \
  -f docker-compose.runtime.yml --profile update up -d --force-recreate \
  db-candidate candidate-bootstrap candidate-migrator backend-candidate

echo "Candidate started without a host port. Probe it only inside its container:"
echo "docker compose --env-file '$BONNI_RUNTIME_ENV_FILE' --env-file '$BONNI_ACTIVE_RELEASE_ENV_FILE' -f docker-compose.runtime.yml --profile update exec -T backend-candidate node -e \"fetch('http://127.0.0.1:4000/api/health/update-probe').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))\""
