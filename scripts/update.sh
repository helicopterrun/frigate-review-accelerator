#!/usr/bin/env bash
# =============================================================================
# update.sh — Pull latest changes and apply them to a running instance
#
# Usage:
#   ./scripts/update.sh              # update everything
#   ./scripts/update.sh --no-pull   # skip git pull (local edits already applied)
#   ./scripts/update.sh --backend   # backend only
#   ./scripts/update.sh --frontend  # frontend only
#
# Assumes:
#   - Project root is one level up from this script
#   - Backend venv is at backend/.venv
#   - Frontend deps managed via npm
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
VENV="$BACKEND_DIR/.venv"

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}[update]${NC} $*"; }
warn()    { echo -e "${YELLOW}[update]${NC} $*"; }
error()   { echo -e "${RED}[update]${NC} $*" >&2; }

# ── Argument parsing ──────────────────────────────────────────────────────────
DO_PULL=true
DO_BACKEND=true
DO_FRONTEND=true

for arg in "$@"; do
  case "$arg" in
    --no-pull)   DO_PULL=false ;;
    --backend)   DO_FRONTEND=false ;;
    --frontend)  DO_BACKEND=false ;;
    --help|-h)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      error "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"

# ── Git pull ──────────────────────────────────────────────────────────────────
if $DO_PULL; then
  info "Pulling latest changes..."
  git pull --ff-only || {
    warn "Fast-forward pull failed — you may have local changes."
    warn "Run with --no-pull if you've already applied edits manually."
    exit 1
  }
  info "Git pull complete: $(git log -1 --format='%h %s')"
fi

# ── Backend ───────────────────────────────────────────────────────────────────
if $DO_BACKEND; then
  info "Updating backend..."

  if [[ ! -d "$VENV" ]]; then
    warn "Virtualenv not found at $VENV — creating..."
    python3 -m venv "$VENV"
  fi

  # shellcheck disable=SC1091
  source "$VENV/bin/activate"

  pip install -q --upgrade pip
  pip install -q -r "$BACKEND_DIR/requirements.txt"

  info "Backend dependencies up to date."
  deactivate
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
if $DO_FRONTEND; then
  info "Updating frontend..."

  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    warn "node_modules missing — running full npm install..."
  fi

  cd "$FRONTEND_DIR"
  npm install --silent
  info "Frontend dependencies up to date."
  cd "$PROJECT_ROOT"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
info "Update complete. Run ./scripts/restart.sh to apply changes."
