#!/bin/sh
set -eu
umask 077

if [ -n "${RAILWAY_PROJECT_ID:-}" ] && [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != /home/node ]; then
  echo 'Attach a Railway volume at /home/node before starting this service.' >&2
  exit 1
fi

mkdir -p /home/node/workspaces /home/node/.t3 /home/node/.codex
chown node:node /home/node /home/node/workspaces /home/node/.t3 /home/node/.codex
cd /home/node/workspaces
exec gosu node t3 serve --host 0.0.0.0 --port "${PORT:-3773}" \
  --base-dir /home/node/.t3 /home/node/workspaces
