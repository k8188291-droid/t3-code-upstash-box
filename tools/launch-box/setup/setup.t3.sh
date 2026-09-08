#!/usr/bin/env bash
set -euo pipefail

cd /workspace/home

if [[ ! -f /workspace/home/t3-background.sh ]]; then
  echo "Missing /workspace/home/t3-background.sh" >&2
  exit 1
fi

# t3-background.sh uses flock and ss for safe process/port management.
missing_system_packages=0
command -v flock >/dev/null || missing_system_packages=1
command -v setsid >/dev/null || missing_system_packages=1
command -v ss >/dev/null || missing_system_packages=1
command -v curl >/dev/null || missing_system_packages=1

if [[ "$missing_system_packages" == 1 ]]; then
  if [[ "$(id -u)" == 0 ]]; then
    apt-get update
    apt-get install -y util-linux iproute2 curl
  elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
    sudo apt-get update
    sudo apt-get install -y util-linux iproute2 curl
  else
    echo "缺少 flock/setsid/ss/curl，且目前帳號無法安裝系統套件。" >&2
    exit 1
  fi
fi

echo "Installing Codex CLI..."
if command -v codex >/dev/null; then
  echo "Codex CLI already installed: $(codex --version)"
else
  CODEX_PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/codex-cli"
  npm install --prefix "$CODEX_PREFIX" --no-audit --no-fund @openai/codex
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$CODEX_PREFIX/node_modules/.bin/codex" "$HOME/.local/bin/codex"
fi

echo "Installing T3 Code 0.0.39..."
T3_RUNTIME="${XDG_DATA_HOME:-$HOME/.local/share}/t3-background/runtime"
npm install --prefix "$T3_RUNTIME" --no-audit --no-fund t3@0.0.39

chmod +x /workspace/home/t3-background.sh

# The Upstash Public URL is the external HTTPS endpoint, so the T3 server itself
# can serve without the optional local CORS preload file.
export T3_UPSTASH_EDGE_CORS=0
/workspace/home/t3-background.sh start
/workspace/home/t3-background.sh status

curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3773/.well-known/t3/environment >/dev/null

echo "T3 Code and Codex are ready on port 3773."
