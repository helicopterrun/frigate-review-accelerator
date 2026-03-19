#!/usr/bin/env bash
# =============================================================================
# restart.sh — Cleanly stop and restart backend and/or frontend
#
# Usage:
#   ./scripts/restart.sh             # restart everything
#   ./scripts/restart.sh --backend  # backend only
#   ./scripts/restart.sh --frontend # frontend only
#   ./scripts/restart.sh --stop     # stop everything, don't restart
#
# Logs:
#   backend:  logs/backend.log
#   frontend: logs/frontend.log
#
# PIDs:
#   .pids/backend.pid
#   .pids/frontend.pid
# =============================================================================

set -euo pipefail

# When this script is invoked from the admin SSE endpoint, its stdout is
# connected to uvicorn's asyncio pipe reader.  Step 1 of a backend restart
# is killing uvicorn, which closes that pipe's read end.  Without this trap,
# the next echo/info call produces EPIPE → SIGPIPE, and set -e exits the
# script before the new uvicorn process is ever started.
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
VENV="$BACKEND_DIR/.venv"
LOG_DIR="$PROJECT_ROOT/logs"
PID_DIR="$PROJECT_ROOT/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
# '|| true' prevents set -e from triggering if the write end of the pipe is
# closed (e.g. when uvicorn dies mid-restart and nobody reads our stdout).
info()    { echo -e "${GREEN}[restart]${NC} $*" || true; }
warn()    { echo -e "${YELLOW}[restart]${NC} $*" || true; }
error()   { echo -e "${RED}[restart]${NC} $*" >&2 || true; }
section() { echo -e "\n${CYAN}── $* ──${NC}" || true; }

# ── Argument parsing ──────────────────────────────────────────────────────────
DO_BACKEND=true
DO_FRONTEND=true
DO_START=true

for arg in "$@"; do
  case "$arg" in
    --backend)   DO_FRONTEND=false ;;
    --frontend)  DO_BACKEND=false ;;
    --stop)      DO_START=false ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      error "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# ── Stop helpers ──────────────────────────────────────────────────────────────
stop_by_pid() {
  local name="$1"
  local pidfile="$PID_DIR/${name}.pid"

  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      info "Stopping $name (PID $pid)..."
      kill "$pid"
      # Wait up to 5s for clean exit
      for _ in {1..10}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        warn "$name didn't exit cleanly — sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
      fi
    else
      warn "$name PID $pid not running (stale pidfile)"
    fi
    rm -f "$pidfile"
  fi
}

stop_by_pattern() {
  local name="$1"
  local pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    info "Killing stray $name processes..."
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
  fi
}

# ── Backend ───────────────────────────────────────────────────────────────────
if $DO_BACKEND; then
  section "Backend"
  stop_by_pid "backend"
  stop_by_pattern "uvicorn" "uvicorn app.main:app"

  if $DO_START; then
    if [[ ! -f "$VENV/bin/activate" ]]; then
      error "Virtualenv not found at $VENV — run ./scripts/update.sh first"
      exit 1
    fi

    info "Starting uvicorn..."
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"

    cd "$BACKEND_DIR"
    # Clear stale pyc caches to avoid import errors after file changes
    find . -name "*.pyc" -delete 2>/dev/null || true
    find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

    nohup uvicorn app.main:app \
      --host 0.0.0.0 \
      --port 8100 \
      --log-level info \
      >> "$LOG_DIR/backend.log" 2>&1 &

    echo $! > "$PID_DIR/backend.pid"
    deactivate
    cd "$PROJECT_ROOT"

    # Verify it came up
    sleep 2
    if kill -0 "$(cat "$PID_DIR/backend.pid")" 2>/dev/null; then
      info "Backend started (PID $(cat "$PID_DIR/backend.pid")) → logs/backend.log"
    else
      error "Backend failed to start — check logs/backend.log"
      tail -20 "$LOG_DIR/backend.log"
      exit 1
    fi
  fi
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
if $DO_FRONTEND; then
  section "Frontend"
  stop_by_pid "frontend"
  stop_by_pattern "vite" "vite"

  if $DO_START; then
    if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
      error "node_modules missing — run ./scripts/update.sh first"
      exit 1
    fi

    info "Starting Vite dev server..."
    cd "$FRONTEND_DIR"

    nohup npm run dev -- --host \
      >> "$LOG_DIR/frontend.log" 2>&1 &

    echo $! > "$PID_DIR/frontend.pid"
    cd "$PROJECT_ROOT"

    sleep 2
    if kill -0 "$(cat "$PID_DIR/frontend.pid")" 2>/dev/null; then
      info "Frontend started (PID $(cat "$PID_DIR/frontend.pid")) → logs/frontend.log"
    else
      error "Frontend failed to start — check logs/frontend.log"
      tail -20 "$LOG_DIR/frontend.log"
      exit 1
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
if $DO_START; then
  echo "" || true
  info "All services running. Tail logs with:"
  echo "       ./scripts/logs.sh" || true
fi
