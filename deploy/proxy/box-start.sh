#!/bin/bash
set -euo pipefail
umask 077
cd /workspace/home/proxy-box
exec 9>start.lock
flock -w 10 9
bash /workspace/home/t3-background.sh start 9>&-
# PID checks include the command path; unrelated processes are never stopped.
if ! pgrep -f '^node /workspace/home/proxy-box/box-control.mjs$' >/dev/null; then
  nohup node /workspace/home/proxy-box/box-control.mjs </dev/null >>control.log 2>&1 9>&- &
fi
if ! pgrep -f '^/workspace/home/proxy-box/chisel client ' >/dev/null; then
  set -a
  source /workspace/home/proxy-box/tunnel.env
  set +a
  nohup /workspace/home/proxy-box/chisel client --keepalive 25s --max-retry-interval 5s \
    "$PROXY_TUNNEL_URL" R:127.0.0.1:4773:127.0.0.1:3773 R:127.0.0.1:4774:127.0.0.1:3774 \
    </dev/null >>chisel.log 2>&1 9>&- &
fi
date
