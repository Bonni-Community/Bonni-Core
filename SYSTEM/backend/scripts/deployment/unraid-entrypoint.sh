#!/bin/sh
set -eu
umask 027

# Require a dedicated persistent mount before accepting an installation.
if ! mountpoint -q /bonni-data; then
  echo 'Bonni Core benötigt ein eigenes persistentes Verzeichnis auf /bonni-data.' >&2
  exit 1
fi

exec flock --exclusive --nonblock --no-fork /bonni-data node /app/backend/scripts/deployment/unraid-runtime.mjs
