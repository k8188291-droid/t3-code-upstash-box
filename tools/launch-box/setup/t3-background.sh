#!/usr/bin/env bash
# T3 Code for an Upstash Box Public URL. Does not configure Box auto-resume.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/t3-background"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/t3-background/runtime"
ENTRY="$INSTALL_DIR/node_modules/t3/dist/bin.mjs"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
PORT=3773
VERSION=0.0.39
ACTION="${1:-start}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ "$ACTION" == __run ]]; then
  cd "$SCRIPT_DIR"
  export TUNNEL_TRANSPORT_PROTOCOL=http2
  NODE_ARGS=()
  # Optional edge CORS preload; enable only when the companion file is installed.
  if [[ "${T3_UPSTASH_EDGE_CORS:-0}" == 1 ]]; then
    NODE_ARGS+=(--require "$SCRIPT_DIR/t3-upstash-cors.cjs")
  fi
  exec node "${NODE_ARGS[@]}" "$ENTRY" serve --host 0.0.0.0 --port "$PORT"
fi

case "$ACTION" in
  start|stop|restart|status|logs) ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs}"; exit 2 ;;
esac

for dependency in node npm flock setsid curl ss; do
  command -v "$dependency" >/dev/null || { echo "Missing command: $dependency" >&2; exit 1; }
done

# Children must not inherit this lock; otherwise later status/stop calls hang.
exec 9>"$STATE_DIR/control.lock"
flock -w 10 9 || { echo 'Another T3 control command is running.' >&2; exit 1; }

process_stamp() {
  # Strip the parenthesized comm field before selecting starttime (field 22).
  local stat
  [[ -r "/proc/$1/stat" ]] || return 1
  stat="$(cat "/proc/$1/stat")"
  stat="${stat##*) }"
  [[ "$stat" != Z\ * && "$stat" != X\ * ]] || return 1
  awk '{print $20}' <<< "$stat"
}

managed_running() {
  local saved_stamp current_stamp
  [[ -f "$PID_FILE" ]] || return 1
  read -r SERVER_PID saved_stamp < "$PID_FILE" || return 1
  [[ "$SERVER_PID" =~ ^[0-9]+$ && "$saved_stamp" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$SERVER_PID" 2>/dev/null || return 1
  current_stamp="$(process_stamp "$SERVER_PID")" || return 1
  [[ "$current_stamp" == "$saved_stamp" ]]
}

port_listener() { ss -H -lntp "sport = :$PORT"; }

start_server() {
  if managed_running; then
    echo "T3 is already running (PID $SERVER_PID)."
    return
  fi
  if [[ -n "$(port_listener)" ]]; then
    echo "Port $PORT is occupied by a process outside this script; no second server was started." >&2
    port_listener >&2
    return 1
  fi
  if [[ ! -f "$ENTRY" ]]; then
    echo "Installing T3 $VERSION into $INSTALL_DIR (first start only)..."
    npm install --prefix "$INSTALL_DIR" --no-audit --no-fund "t3@$VERSION" 9>&-
  fi
  if [[ -f "$LOG_FILE" ]]; then mv -f "$LOG_FILE" "$LOG_FILE.previous"; fi
  : > "$LOG_FILE"
  # Detach from the terminal, ignore SIGHUP, and close stdin and the lock fd.
  nohup setsid bash "$SCRIPT_DIR/t3-background.sh" __run \
    </dev/null >>"$LOG_FILE" 2>&1 9>&- &
  SERVER_PID=$!
  local stamp
  stamp="$(process_stamp "$SERVER_PID")"
  printf '%s %s\n' "$SERVER_PID" "$stamp" > "$PID_FILE"
  for ((attempt=0; attempt<30; attempt++)); do
    if ! managed_running; then
      echo "T3 exited during startup. Read $LOG_FILE" >&2
      rm -f "$PID_FILE"
      return 1
    fi
    if [[ "$(port_listener)" == *"pid=$SERVER_PID,"* ]] && \
      curl --noproxy '*' --fail --silent --max-time 2 \
        "http://127.0.0.1:$PORT/.well-known/t3/environment" >/dev/null; then
      echo "T3 started in background (PID $SERVER_PID), listening on 0.0.0.0:$PORT."
      echo "Log: $LOG_FILE"
      return
    fi
    sleep 1
  done
  echo "T3 is still starting (PID $SERVER_PID). Check $LOG_FILE" >&2
  return 1
}

stop_server() {
  if ! managed_running; then
    rm -f "$PID_FILE"
    echo 'No server managed by this script is running.'
    return
  fi
  kill -TERM "$SERVER_PID"
  for ((attempt=0; attempt<30; attempt++)); do
    if ! managed_running; then
      rm -f "$PID_FILE"
      echo 'T3 stopped.'
      return
    fi
    sleep 1
  done
  echo "T3 has not stopped yet (PID $SERVER_PID); not forcing termination. Check $LOG_FILE" >&2
  return 1
}

case "$ACTION" in
  start) start_server ;;
  stop) stop_server ;;
  restart) stop_server; start_server ;;
  status)
    if managed_running; then
      echo "T3 is running (PID $SERVER_PID)."
      port_listener
      echo "Log: $LOG_FILE"
    else
      echo 'No server managed by this script is running.'
      port_listener
      exit 1
    fi
    ;;
  logs)
    flock -u 9
    [[ -f "$LOG_FILE" ]] || { echo 'No log yet.'; exit 1; }
    exec tail -n 60 -f "$LOG_FILE"
    ;;
esac
