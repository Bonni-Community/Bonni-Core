#!/bin/sh
set -eu

if [ "${BONNI_DEPLOYMENT_MODE:-}" = unraid-single-container ]; then
  if [ "$(uname -m)" != x86_64 ] || [ ! -x /usr/local/pgsql/bin/postgres ]; then
    echo 'Die Unraid-Einrichtung benötigt das Bonni-Core-Image für AMD64.' >&2
    exit 1
  fi
  exec /opt/bonni-engines/entrypoint.sh /bin/sh /app/backend/scripts/deployment/unraid-entrypoint.sh
fi

exec /opt/bonni-engines/entrypoint.sh "$@"
