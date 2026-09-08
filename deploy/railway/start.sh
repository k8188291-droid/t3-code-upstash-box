#!/bin/sh
set -eu
umask 077

if [ -n "${RAILWAY_PROJECT_ID:-}" ] && [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != /home/node ]; then
  echo 'Attach a Railway volume at /home/node before starting this service.' >&2
  exit 1
fi

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  backupctl init
fi
if [ -n "${T3_RESTORE_SNAPSHOT:-}" ] && [ ! -f /home/node/.restore-complete ]; then
  backupctl restore --snapshot "$T3_RESTORE_SNAPSHOT" --target /home/node
  printf '%s\n' "$T3_RESTORE_SNAPSHOT" > /home/node/.restore-complete
fi
mkdir -p /home/node/workspaces /home/node/.t3 /home/node/.codex
chown node:node /home/node /home/node/workspaces /home/node/.t3 /home/node/.codex
cd /home/node/workspaces
exec /usr/local/bin/t3-supervisor
