#!/usr/bin/env bash
set -euo pipefail
root="${BONNI_HOST_PROJECT_ROOT:?Persistenter Datenordner fehlt}"
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ ]] && [ "$root" != / ] || exit 2
test -d "$root"
test ! -L "$root/.bonni-controller.lock"
exec 9>"$root/.bonni-controller.lock"
flock --nonblock 9 || { echo 'Dieser Bonni-Datenordner wird bereits verwaltet.' >&2; exit 2; }
export BONNI_DEPLOYMENT_LOCK_HELD=true
exec node /app/backend/scripts/deployment/controller.mjs
