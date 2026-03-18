#!/usr/bin/env bash
# =============================================================================
# logs.sh — Tail and filter logs for Frigate Review Accelerator
#
# Usage:
#   ./scripts/logs.sh                  # tail both logs (last 50 lines each)
#   ./scripts/logs.sh --backend        # backend only
#   ./scripts/logs.sh --frontend       # frontend only
#   ./scripts/logs.sh --previews       # preview worker activity only
#   ./scripts/logs.sh --errors         # errors and warnings only
#   ./scripts/logs.sh --health         # health check hits (noisy, off by default)
#   ./scripts/logs.sh --since 10m      # last 10 minutes of logs
#   ./scripts/logs.sh --lines 100      # show last N lines before tailing
#   ./scripts/logs.sh --no-follow      # print and exit (don't tail)
#   ./scripts/logs.sh --status         # show worker status snapshot, then exit
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; DIM='\033[2m'; NC='\033[0m'

# ── Defaults ──────────────────────────────────────────────────────────────────
SHOW_BACKEND=true
SHOW_FRONTEND=true
FILTER_PREVIEWS=false
FILTER_ERRORS=false
FILTER_HEALTH=false
FOLLOW=true
LINES=50
SINCE=""
STATUS_ONLY=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)    SHOW_FRONTEND=false ;;
    --frontend)   SHOW_BACKEND=false ;;
    --previews)   FILTER_PREVIEWS=true; SHOW_FRONTEND=false ;;
    --errors)     FILTER_ERRORS=true ;;
    --health)     FILTER_HEALTH=true ;;
    --no-follow)  FOLLOW=false ;;
    --status)     STATUS_ONLY=true ;;
    --lines)      LINES="$2"; shift ;;
    --since)      SINCE="$2"; shift ;;
    --help|-h)
      sed -n '2,17p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# ── Helpers ───────────────────────────────────────────────────────────────────
check_log() {
  local logfile="$1"
  if [[ ! -f "$logfile" ]]; then
    echo -e "${YELLOW}Log not found: $logfile${NC}"
    echo "  Start the service with ./scripts/restart.sh"
    return 1
  fi
  return 0
}

# Colourize log lines:
#   ERROR/WARNING → red/yellow
#   Worker tiers  → distinct colours per tier
#   HTTP requests → dim (usually noise)
colorize() {
  sed \
    -e "s/ERROR/${RED}ERROR${NC}/g" \
    -e "s/WARNING/${YELLOW}WARNING${NC}/g" \
    -e "s/\(Recency pass\)/${GREEN}\1${NC}/g" \
    -e "s/\(On-demand\)/${CYAN}\1${NC}/g" \
    -e "s/\(Background pass\)/${MAGENTA}\1${NC}/g" \
    -e "s/\(Indexed [0-9]* new\)/${GREEN}\1${NC}/g" \
    -e "s/\(Background worker started\)/${GREEN}\1${NC}/g" \
    -e "s/\(ImportError\|ModuleNotFoundError\|Traceback\)/${RED}\1${NC}/g" \
    -e "s/^\(.*GET \/api\/health.*\)$/${DIM}\1${NC}/g"
}

# ── --status: quick snapshot ──────────────────────────────────────────────────
if $STATUS_ONLY; then
  echo -e "${CYAN}── Worker Status Snapshot ──${NC}"

  if check_log "$BACKEND_LOG"; then
    echo ""
    echo -e "${GREEN}Last index run:${NC}"
    grep "Indexed.*new segments" "$BACKEND_LOG" | tail -1 || echo "  (none found)"

    echo ""
    echo -e "${GREEN}Last recency pass:${NC}"
    grep "Recency pass" "$BACKEND_LOG" | tail -1 || echo "  (none yet — worker may still be starting)"

    echo ""
    echo -e "${CYAN}Last on-demand pass:${NC}"
    grep "On-demand" "$BACKEND_LOG" | tail -1 || echo "  (none yet)"

    echo ""
    echo -e "${MAGENTA}Last background pass:${NC}"
    grep "Background pass" "$BACKEND_LOG" | tail -1 || echo "  (none yet)"

    echo ""
    echo -e "${YELLOW}Recent errors:${NC}"
    grep -E "ERROR|WARNING|ImportError|Traceback" "$BACKEND_LOG" | tail -5 || echo "  (none)"

    echo ""
    echo -e "${DIM}Preview cache stats:${NC}"
    curl -s http://localhost:8100/api/preview/stats 2>/dev/null \
      | python3 -m json.tool 2>/dev/null \
      || echo "  (backend not reachable on :8100)"
  fi

  exit 0
fi

# ── Build grep filter ─────────────────────────────────────────────────────────
# We compose an egrep pattern to include/exclude log lines.
INCLUDE_PATTERN=""
EXCLUDE_PATTERN=""

if $FILTER_PREVIEWS; then
  INCLUDE_PATTERN="Recency pass|On-demand|Background pass|Indexed|worker|preview|Preview"
fi

if $FILTER_ERRORS; then
  INCLUDE_PATTERN="${INCLUDE_PATTERN:+$INCLUDE_PATTERN|}ERROR|WARNING|Exception|Traceback|ImportError"
fi

if ! $FILTER_HEALTH; then
  # Health checks are frequent and uninteresting — exclude by default
  EXCLUDE_PATTERN="GET /api/health"
fi

apply_filters() {
  local stream="$1"
  local filtered="$stream"

  if [[ -n "$INCLUDE_PATTERN" ]]; then
    filtered=$(echo "$filtered" | grep -E "$INCLUDE_PATTERN" || true)
  fi

  if [[ -n "$EXCLUDE_PATTERN" ]]; then
    filtered=$(echo "$filtered" | grep -vE "$EXCLUDE_PATTERN" || true)
  fi

  echo "$filtered"
}

# ── Print recent lines ─────────────────────────────────────────────────────────
print_recent() {
  local logfile="$1"
  local label="$2"

  [[ -f "$logfile" ]] || return

  echo -e "\n${CYAN}━━━ $label ━━━${NC}"

  local content
  if [[ -n "$SINCE" ]]; then
    # Filter by time — works if log lines start with a timestamp
    content=$(grep "$(date -d "-$SINCE" '+%Y-%m-%d %H:%M' 2>/dev/null || true)" "$logfile" 2>/dev/null || tail -"$LINES" "$logfile")
  else
    content=$(tail -"$LINES" "$logfile")
  fi

  if [[ -n "$INCLUDE_PATTERN" ]] || [[ -n "$EXCLUDE_PATTERN" ]]; then
    content=$(echo "$content" \
      | { [[ -n "$INCLUDE_PATTERN" ]] && grep -E "$INCLUDE_PATTERN" || cat; } \
      | { [[ -n "$EXCLUDE_PATTERN" ]] && grep -vE "$EXCLUDE_PATTERN" || cat; })
  fi

  echo "$content" | colorize
}

# ── Main output ───────────────────────────────────────────────────────────────
$SHOW_BACKEND  && check_log "$BACKEND_LOG"  || true
$SHOW_FRONTEND && check_log "$FRONTEND_LOG" || true

$SHOW_BACKEND  && print_recent "$BACKEND_LOG"  "Backend"
$SHOW_FRONTEND && print_recent "$FRONTEND_LOG" "Frontend (Vite)"

# ── Tail (follow) ─────────────────────────────────────────────────────────────
if $FOLLOW; then
  echo -e "\n${DIM}── Following (Ctrl+C to exit) ──${NC}\n"

  # Build the list of files to tail
  TAIL_FILES=()
  $SHOW_BACKEND  && [[ -f "$BACKEND_LOG"  ]] && TAIL_FILES+=("$BACKEND_LOG")
  $SHOW_FRONTEND && [[ -f "$FRONTEND_LOG" ]] && TAIL_FILES+=("$FRONTEND_LOG")

  if [[ ${#TAIL_FILES[@]} -eq 0 ]]; then
    echo "No log files found. Start services with ./scripts/restart.sh"
    exit 1
  fi

  tail -f "${TAIL_FILES[@]}" | \
    { [[ -n "$INCLUDE_PATTERN" ]] && grep --line-buffered -E "$INCLUDE_PATTERN" || cat; } | \
    { [[ -n "$EXCLUDE_PATTERN" ]] && grep --line-buffered -vE "$EXCLUDE_PATTERN" || cat; } | \
    colorize
fi
