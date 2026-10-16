#!/usr/bin/env bash
# Standalone Docker host entry point; no Node or Bonni Windows required on host.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd "$script_dir/../../../.." && pwd -P)"
backend="$project_root/SYSTEM/backend"
action="${1:-start}"
case "$action" in start|stop) ;; *) echo "Aufruf: bash container-runtime.sh start [Core-Image] | stop" >&2; exit 2;; esac
command -v docker >/dev/null || { echo "Docker fehlt." >&2; exit 2; }
docker info >/dev/null
# Only this application's persisted helper image is used after first setup.
if [ ! -f "$backend/.env" ]; then
  [ "$action" = start ] || { echo "Noch keine Runtime angelegt." >&2; exit 2; }
  image="${2:-}"
  [[ "$image" =~ ^ghcr.io/bonni-community/bonni-core:([0-9]+\.[0-9]+\.[0-9]+(-[a-z])?)$ ]] || {
    echo "Für die Erstinstallation ein veröffentlichtes Image angeben, z.B. ghcr.io/bonni-community/bonni-core:0.1.23" >&2; exit 2;
  }
  version="${BASH_REMATCH[1]}"
  docker pull "$image"
  initial_id="$(docker image inspect --format '{{.Id}}' "$image")"
  # The image label is checked independently of its mutable registry tag.
  actual="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$initial_id")"
  [ "${actual//+/-}" = "$version" ] || { echo "Image-Version stimmt nicht überein." >&2; exit 2; }
  server_timezone="${TZ:-}"
  if [ -z "$server_timezone" ] && [ -r /etc/timezone ]; then
    server_timezone="$(tr -d '\r\n' < /etc/timezone)"
  fi
  if [ -z "$server_timezone" ] && [ -e /etc/localtime ]; then
    timezone_file="$(readlink -f /etc/localtime || true)"
    case "$timezone_file" in */zoneinfo/*) server_timezone="${timezone_file#*/zoneinfo/}";; esac
  fi
  if [ -z "$server_timezone" ] && command -v timedatectl >/dev/null; then
    server_timezone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
  fi
  [ -n "$server_timezone" ] || { echo "Server-Zeitzone nicht ermittelbar. Bitte den Start mit TZ=<Server-Zeitzone> ausführen." >&2; exit 2; }
  docker run --rm --network none --mount "type=bind,src=$project_root,dst=$project_root" \
    -e "TZ=$server_timezone" \
    --entrypoint node "$initial_id" "$script_dir/prepare-public-runtime.mjs" "$project_root" "$actual" "$initial_id"
fi
[ ! -L "$backend/.env" ] || { echo "Unsichere Runtime-Konfiguration." >&2; exit 2; }
# Do not source .env: it is configuration data, never executable shell code.
read_setting() {
  local value
  value="$(sed -n "s/^$1=//p" "$backend/.env")"
  [[ "$value" =~ ^[a-zA-Z0-9:._/@-]+$ ]] || { echo "Runtime-Einstellung $1 fehlt/ist ungültig." >&2; return 2; }
  printf '%s' "$value"
}
runner_image="$(read_setting BONNI_UPDATE_RUNNER_IMAGE)"
proxy_image="$(read_setting BONNI_RUNTIME_PROXY_IMAGE)"
initial_id="$(read_setting BONNI_INITIAL_IMAGE)"
if ! docker image inspect "$runner_image" >/dev/null 2>&1; then
  [ "$action" = start ] || { echo "Update-Dienst fehlt." >&2; exit 2; }
  docker build --build-arg "BONNI_RUNTIME_BASE=$initial_id" \
    -f "$backend/ops/update-runner/Dockerfile.prebuilt" -t "$runner_image" "$project_root"
fi
if ! docker image inspect "$proxy_image" >/dev/null 2>&1; then
  [ "$action" = start ] || { echo "Runtime-Proxy fehlt." >&2; exit 2; }
  docker build -f "$backend/ops/runtime/proxy/Dockerfile" -t "$proxy_image" "$project_root"
fi
# Shared PID/network namespaces are needed only for the host boot gate's checks
# against the host supervisor and listening ports. Application containers have
# neither host networking nor Docker-socket access.
exec docker run --rm --pid host --network host \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  -e "BONNI_INITIAL_IMAGE=$initial_id" -e "BONNI_HOST_PROJECT_ROOT=$project_root" \
  --entrypoint /bin/bash "$runner_image" "$script_dir/${action}-runtime.sh" "$backend"
