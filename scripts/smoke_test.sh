#!/usr/bin/env bash
# smoke_test.sh — fast post-restart sanity check for Frigate Review Accelerator
#
# Usage: ./scripts/smoke_test.sh [--host HOST] [--port PORT]
# Exit code 0 = all checks passed. Non-zero = something is broken.
#
# Checks:
#   1. Backend responds to /api/health within 10s
#   2. /api/cameras returns a JSON array
#   3. /api/preview/stats returns expected fields
#   4. /api/preview/progress returns a JSON array
#   5. Frontend dev server responds (if running)

set -euo pipefail

HOST="${HOST:-localhost}"
BACKEND_PORT="${BACKEND_PORT:-8100}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND="http://${HOST}:${BACKEND_PORT}"
FRONTEND="http://${HOST}:${FRONTEND_PORT}"

PASS=0
FAIL=0
SKIP=0

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

check() {
  local name="$1"
  local result="$2"
  local expected="${3:-}"
  if [ "$result" = "OK" ] || [ -z "$expected" ] && [ -n "$result" ]; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name: $result"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Frigate Review Accelerator — Smoke Test"
echo "Backend: $BACKEND"
echo "========================================"

# ── 1. Health endpoint ────────────────────────────────────────────────────────
printf "Waiting for backend to be ready"
READY=0
for i in $(seq 1 20); do
  if curl -sf "${BACKEND}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf "."
  sleep 0.5
done
echo ""

if [ $READY -eq 0 ]; then
  red "  ✗ Backend did not respond within 10s — is it running?"
  echo ""
  echo "Results: 0 passed, 1 failed. Stopping."
  exit 1
fi

HEALTH=$(curl -sf "${BACKEND}/api/health" 2>/dev/null)
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
check "GET /api/health returns status=ok" "$([ "$STATUS" = "ok" ] && echo OK || echo "status=$STATUS")"

# ── 2. Cameras ────────────────────────────────────────────────────────────────
CAMERAS=$(curl -sf "${BACKEND}/api/cameras" 2>/dev/null || echo "ERROR")
IS_ARRAY=$(echo "$CAMERAS" | python3 -c "import sys,json; v=json.load(sys.stdin); print('OK' if isinstance(v,list) else 'NOT_ARRAY')" 2>/dev/null || echo "PARSE_ERROR")
check "GET /api/cameras returns JSON array" "$IS_ARRAY"

# ── 3. Preview stats ──────────────────────────────────────────────────────────
STATS=$(curl -sf "${BACKEND}/api/preview/stats" 2>/dev/null || echo "ERROR")
HAS_FIELDS=$(echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'hit_rate_pct' in d and 'cache_size' in d else 'MISSING_FIELDS')" 2>/dev/null || echo "PARSE_ERROR")
check "GET /api/preview/stats has expected fields" "$HAS_FIELDS"

# ── 4. Preview progress ───────────────────────────────────────────────────────
PROGRESS=$(curl -sf "${BACKEND}/api/preview/progress" 2>/dev/null || echo "ERROR")
IS_LIST=$(echo "$PROGRESS" | python3 -c "import sys,json; v=json.load(sys.stdin); print('OK' if isinstance(v,list) else 'NOT_LIST')" 2>/dev/null || echo "PARSE_ERROR")
check "GET /api/preview/progress returns JSON array" "$IS_LIST"

# ── 5. Admin status ───────────────────────────────────────────────────────────
ADMIN=$(curl -sf "${BACKEND}/api/admin/status" 2>/dev/null || echo "ERROR")
HAS_WORKER=$(echo "$ADMIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'worker' in d else 'MISSING_WORKER')" 2>/dev/null || echo "PARSE_ERROR")
check "GET /api/admin/status has worker field" "$HAS_WORKER"

# ── 6. Frontend (optional) ────────────────────────────────────────────────────
if curl -sf "${FRONTEND}" >/dev/null 2>&1; then
  check "Frontend responds at ${FRONTEND}" "OK"
else
  yellow "  ~ Frontend not responding at ${FRONTEND} (not required)"
  SKIP=$((SKIP + 1))
fi

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
printf "Results: "
green "${PASS} passed"
printf ", "
if [ $FAIL -gt 0 ]; then red "${FAIL} failed"; else printf "${FAIL} failed"; fi
if [ $SKIP -gt 0 ]; then printf ", "; yellow "${SKIP} skipped"; fi
echo ""
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
