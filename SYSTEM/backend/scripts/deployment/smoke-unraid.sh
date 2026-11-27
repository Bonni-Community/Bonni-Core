#!/usr/bin/env bash
set -Eeuo pipefail

name=bonni-unraid-release-smoke
image=${BONNI_UNRAID_IMAGE:?Bonni-Core-Image für den Unraid-Test fehlt}
data=$(mktemp -d)
trap 'status=$?; if ((status != 0)); then docker logs "$name" 2>&1 | sed -E "s@(Einrichtungscode: )[0-9a-f]{64}@\1[redacted]@g"; fi; docker rm -f "$name" >/dev/null 2>&1 || true; sudo rm -rf -- "$data" || true; exit "$status"' EXIT

start() {
  docker run --detach --name "$name" --init --pull never --stop-timeout 75 \
    --env BONNI_DEPLOYMENT_MODE=unraid-single-container \
    --security-opt no-new-privileges --mount "type=bind,source=$data,target=/bonni-data" \
    --publish "127.0.0.1:$1:4000" "$image"
}

wait_for() {
  local url=$1 expected=$2 response
  for ((attempt = 0; attempt < 120; attempt++)); do
    if response=$(curl -fsS --max-time 3 "$url" 2>/dev/null) && [[ "$response" == *"$expected"* ]]; then return 0; fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then break; fi
    sleep 2
  done
  printf 'Erwartete Web-Antwort fehlt unter %s.\n' "$url" >&2
  return 1
}

assert_single() {
  local current
  current=$(docker ps -aq | sort)
  [[ "$current" == "$(printf '%s\n' "$previous" "$(docker inspect --format '{{.Id}}' "$name" | cut -c1-12)" | sed '/^$/d' | sort)" ]]
}

assert_healthy() {
  local headers
  wait_for "$1/runtime-proxy/active-health" '"ok"'
  wait_for "$1/runtime-proxy/emergency-health" '"ok"'
  wait_for "$1/" '<html'
  if curl -fsS "$1/" | grep -q 'Bonni Core einrichten'; then
    printf 'Die WebUI zeigt weiterhin den Erstinstallationsassistenten.\n' >&2
    return 1
  fi
  headers=$(curl -fsSI --max-time 10 "$1/")
  if ! grep -qi '^content-security-policy:.*script-src' <<<"$headers" \
      || grep -qi '^content-security-policy:.*upgrade-insecure-requests' <<<"$headers"; then
    printf 'Die Sicherheitsrichtlinie der Unraid-WebUI erlaubt den vorgesehenen HTTP-Aufruf nicht.\n' >&2
    return 1
  fi
  assert_single
  curl -fsS --max-time 10 -H "Origin: $1" -H 'Content-Type: application/json' \
    --data "$(printf '{"login":"admin","password":"%s"}' "$password")" \
    "$1/api/identity/auth/login" >/dev/null
}

previous=$(docker ps -aq | sort)
start 14000
setup=http://127.0.0.1:14000
wait_for "$setup/" 'Bonni Core einrichten'
setup_page=$(curl -fsS --max-time 8 "$setup/")
for marker in 'System prüfen' 'Speicherort prüfen' 'Admin-Konto anlegen' 'Einrichtung überprüfen' 'data-pose="3"'; do
  [[ "$setup_page" == *"$marker"* ]]
done
unset setup_page
wait_for "$setup/api/setup/status" '"phase":"waiting"'
token=$(docker logs "$name" 2>&1 | sed -n 's@.*Einrichtungscode: \([a-f0-9]\{64\}\)$@\1@p')
[[ "$token" =~ ^[a-f0-9]{64}$ ]]
password="Bb_$(openssl rand -hex 17)_1"
content=$(printf '{"password":"%s"}' "$password")
curl -fsS --max-time 8 -H "Origin: $setup" -H "X-Bonni-Setup: $token" \
  -H 'Content-Type: application/json' --data "$content" "$setup/api/setup"
unset token content
assert_healthy "$setup"
docker restart --time 75 "$name"
assert_healthy "$setup"

# Unraid saves a changed host port by recreating the same named container.
docker stop --time 75 "$name"
docker rm "$name"
start 14080
assert_healthy http://127.0.0.1:14080
