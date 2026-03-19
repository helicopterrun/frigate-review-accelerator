# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Frigate Review Accelerator — Claude Code Context

## What this project is

A high-performance video review interface that sits alongside Frigate NVR.
It does NOT replace Frigate — it adds fast timeline scrubbing and preview
thumbnails on top of Frigate's existing recordings.

- **Backend:** FastAPI + SQLite + ffmpeg, port 8100
- **Frontend:** React + Vite, port 5173
- **Host:** Ubuntu server (`nvr`), recordings at `/mnt/frigate-storage/recordings/recordings`

-----

## The core architectural invariant — do not violate this

```
Scrubbing = image lookup.   Playback = video decode.   Never mix them.
```

Preview filenames ARE their timestamp: `1700000004.00.jpg`
Lookup is pure math — no database query on the hot path:

```python
bucket_ts = round(ts / interval) * interval
path = preview_output_path / camera / YYYY-MM-DD / f"{bucket_ts:.2f}.jpg"
```

If you add a DB call to `GET /api/preview/{camera}/{ts}` you have broken the design.

-----

## Project structure

```
frigate-review-accelerator/
  backend/
    app/
      config.py               # All settings via pydantic-settings / .env
      main.py                 # FastAPI app, lifespan, CORS, router mounts
      models/
        database.py           # SQLite schema, WAL mode, get_db() async context manager
        schemas.py            # Pydantic request/response models
      routers/
        preview.py            # GET /api/preview/{camera}/{ts}  ← HOT PATH
        timeline.py           # GET /api/timeline, /api/playback, /api/health
        admin.py              # GET/POST /api/admin/* (SSE log stream, script runner)
      services/
        indexer.py            # Filesystem walker → segments table
        preview_generator.py  # ffmpeg thumbnail extractor
        worker.py             # Background task: index → on-demand → recency → background
        event_sync.py         # Frigate event poller → events table
        hls.py                # Frigate VOD URL construction + reachability cache
    requirements.txt
    .env                      # Not in git — copy from .env.example
  frontend/
    src/
      App.jsx                 # All state lives here. Single source of truth.
      components/
        Timeline.jsx          # Canvas-only rendering. HOVER/DRAG/RELEASE state machine.
        VideoPlayer.jsx       # Receives PlaybackTarget prop, never does segment math
        CameraSelector.jsx
        AdminPanel.jsx        # SSE log viewer + restart/update/pull buttons
      utils/
        api.js                # All fetch calls. One function per endpoint.
        time.js               # Timestamp formatting helpers
  scripts/
    update.sh                 # git pull + pip install + npm install
    restart.sh                # Stop/start uvicorn + vite, manages logs/ and .pids/
    logs.sh                   # Tail + filter logs with colour coding
```

-----

## Running the project

**External dependencies required:** `ffmpeg` and `ffprobe` must be on PATH.

```bash
# First-time setup
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then edit .env

# Backend (dev)
cd backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload

# Frontend (dev, separate terminal)
cd frontend
npm install
npm run dev

# Frontend (production build)
cd frontend
npm run build

# Or use scripts after first manual setup:
./scripts/restart.sh                  # restart everything
./scripts/restart.sh --backend        # backend only
./scripts/restart.sh --frontend       # frontend only
./scripts/restart.sh --stop           # stop only
./scripts/logs.sh --previews          # watch preview generation
./scripts/logs.sh --status            # snapshot of worker state
./scripts/logs.sh --errors            # errors/warnings only
```

**Frontend → Backend proxy:** Vite proxies all `/api` requests to `http://localhost:8100`. This means `api.js` uses relative `/api` paths in dev — no CORS issue during local development.

-----

## Database schema (SQLite, WAL mode)

```sql
segments     — one row per Frigate MP4 segment
  id, camera, start_ts, end_ts, duration, path, file_size, indexed_at
  previews_generated  INTEGER  0=pending  1=done

previews     — one row per extracted JPEG thumbnail
  id, camera, ts, segment_id, image_path, width, height

events       — cached Frigate detections (person/car/dog etc)
  id, camera, start_ts, end_ts, label, score, has_clip, has_snapshot, synced_at

scan_state   — last scan position per camera (used for incremental indexing)
  camera, last_scanned_ts, last_file_path
```

Always use `get_db()` async context manager for DB access in routers.
Use synchronous `sqlite3` directly in services (they run in thread pool via `run_in_executor`).

-----

## Background worker priority model

Three tiers, processed in order every `scan_interval_sec` (default 30s):

```
Tier 0 — On-demand   : segments in _demand_queue (user just opened this window)
Tier 1 — Recency     : segments newer than preview_recency_hours (default 48h)
Tier 2 — Background  : all remaining pending, every BACKGROUND_INTERVAL=10 cycles
```

The `_demand_queue` is an in-process `deque`. **Do not run uvicorn with –workers > 1**
or on-demand requests will silently go to the wrong worker process.

-----

## Key config settings (.env)

```
FRIGATE_RECORDINGS_PATH=/mnt/frigate-storage/recordings/recordings
FRIGATE_API_URL=http://localhost:5000
PREVIEW_OUTPUT_PATH=./data/previews
DATABASE_PATH=./data/accelerator.db
PREVIEW_INTERVAL_SEC=2
PREVIEW_WIDTH=320
PREVIEW_RECENCY_HOURS=48
PREVIEW_BACKGROUND_BATCH=20
SCAN_INTERVAL_SEC=30
CORS_ORIGINS=["http://localhost:5173"]
```

-----

## Current production state (March 2026)

- ~1,489,685 segments across 9 cameras
- 0 previews generated (worker running, recency pass active)
- Backend stable, frontend stable
- Admin panel (⚙ Ops button, bottom-right) operational
- HLS VOD playback via Frigate's /api/vod/ API (hls.js in frontend)
- MP4 segment fallback when Frigate VOD unreachable

-----

## Known bugs — v2 (all fixed)

All v2 bugs are resolved. See git log for details.

## Known issues — v3

### 1. HLS seek offset edge case (low priority)

In VideoPlayer.jsx the seek offset into the HLS window is capped at 30s:
  const seekOffset = Math.min(playbackTarget.offset_sec, 30)
This is correct because _build_hls_url starts the window at max(seg_start, requested_ts - 30).
Edge case: if requested_ts - seg_start > 30, offset_sec > 30 and the cap kicks in,
placing the seek slightly before the requested position. Frigate segments are ~10s
so this never triggers in practice, but it's worth noting.

### 2. HLS reachability cache is process-local

_hls_reachable_cache lives in the uvicorn process. Do NOT run uvicorn with
--workers > 1 (this was already a constraint for the demand queue). This is documented.

### 3. Frigate VOD URL uses /api/vod/ path

Frigate exposes VOD at `{frigate_api_url}/api/vod/{camera}/start/{t}/end/{t}`.
The path `/vod/` (without /api/ prefix) returns nginx 400. _build_hls_url in
hls.py uses the correct /api/vod/ path.

-----

## Planned v3 features

1. **HLS window extension** — When playback reaches within 60s of the end of the
   current HLS window, fetch a new PlaybackTarget centered on the current absoluteTs
   and reload the hls.js source. This gives effectively unlimited continuous playback.
   Add onWindowExhausting(currentTs) callback from VideoPlayer → App.jsx.

2. **Frigate event sync paging** — event_sync.py fetches one page of 100 events.
   If a camera has >100 new events since last sync, older ones are silently skipped.
   Fix: paginate using Frigate's after/before params until response length < _LIMIT.

3. **Preview retention verification** — At 2s intervals, 9 cameras, 30 days:
   ~175GB of preview JEPGs. Confirm delete_old_previews runs and verify disk usage
   is stable before increasing preview_retention_days.

-----

## Testing

```bash
# Run all tests
cd backend && pytest

# Run a single test
cd backend && pytest tests/unit/test_preview.py::test_quantize_ts_alignment -v

# Run with coverage
cd backend && pytest --cov=app tests/
```

Test structure:

```
backend/tests/
  unit/
    test_indexer.py        # parse_segment_path, _global_bucket_timestamps
    test_preview.py        # _quantize_ts, _bucket_path — the O(1) invariants
    test_timeline.py       # _compute_gaps, _compute_activity, coverage_pct
    test_scan_state.py     # incremental scan state per camera
  integration/
    test_api.py            # httpx AsyncClient against real in-memory SQLite
    test_playback_hls.py   # HLS URL construction + reachability cache
    conftest.py            # fixtures
```

Use `pytest` + `pytest-asyncio` + `httpx.AsyncClient`.
Use SQLite `:memory:` for integration tests.
Mock `subprocess.run` at the boundary in unit tests — never call real ffmpeg.
Patch `app.services.hls.httpx.AsyncClient` when mocking Frigate reachability.

-----

## Conventions

- All timestamps are Unix floats (seconds since epoch). Never use datetime objects
  in the API layer — convert at the boundary only.
- Relative paths in the DB (`segments.path`, `previews.image_path`) are always
  relative to their respective root (`frigate_recordings_path`, `preview_output_path`).
- Frontend never does segment math. Always call `/api/playback` and use the result.
- State ownership: App.jsx owns everything. Child components get props + callbacks.
- Log at INFO for worker progress, DEBUG for hot path (preview lookup, bucket math).
  Never log inside the scrub hot path.

-----

## Workflow: Claude Chat → Claude Code

This project uses a two-mode AI workflow to keep changes fast, safe, and reviewable.

### Roles

**Claude Chat** (claude.ai chat interface)
- Diagnoses bugs and designs fixes
- Does NOT write the implementation directly
- Outputs a ready-to-paste prompt for Claude Code

**Claude Code** (claude.ai/code, runs in the repo)
- Reads this file first at the start of every task (see prompt template below)
- Implements the fix
- Writes or updates tests
- Opens a PR against `main`

### Claude Chat behavior

When a bug or feature is discussed in Claude Chat, the final output should be
a Claude Code prompt using the template below. Do not write implementation code
in the chat response itself — write the prompt that will drive Claude Code to
do it correctly.

### Claude Code prompt template

Every prompt sent to Claude Code must open with this line:

```
Read CLAUDE.md in full before making any changes.
```

Then include:

```
## Problem
<one paragraph: what is broken or missing, and why>

## Location
<file(s) and line numbers or function names affected>

## Fix
<precise description of the change — specific enough that there is only one
correct implementation. Include the before/after if it helps.>

## Tests
<which existing test file(s) to update, OR description of new test(s) to add.
All PRs must include test coverage for the change.>

## PR
Open a PR against main titled: <type>(<scope>): <short description>
Types: fix | feat | refactor | test | chore
Example: fix(frontend): stale closure in health poll resets selected camera
```

### Example prompt (the camera reset bug)

```
Read CLAUDE.md in full before making any changes.

## Problem
The 30-second health poll in App.jsx captures `selectedCamera = null` at mount
time because the useEffect dependency array is `[]`. Every poll cycle evaluates
`!selectedCamera` against the stale null and resets the selected camera to
cams[0].name (alley east), interrupting playback and scrubbing on all other cameras.

## Location
frontend/src/App.jsx — inside the `useEffect` init function, the camera
initialization block (~line 198).

## Fix
Replace:
  if (cams.length > 0 && !selectedCamera) {
    setSelectedCamera(cams[0].name);
  }

With:
  if (cams.length > 0) {
    setSelectedCamera(prev => prev ?? cams[0].name);
  }

The functional updater form reads current state at call time, bypassing the
stale closure. If a camera is already selected, prev ?? cams[0].name returns
prev unchanged.

## Tests
Add a test to frontend (or note that this is a React state closure bug with
no existing frontend test harness — in that case document it in the PR and
add a TODO comment in the source).

## PR
Open a PR against main titled:
fix(frontend): stale closure in health poll resets selected camera
```

### Rules

- Claude Code always reads CLAUDE.md first — the prompt must say so explicitly
- PRs always target `main`
- Every PR must include tests, or a documented reason why tests are not possible
  and a TODO comment in the source
- Claude Chat never implements — it diagnoses and prompts
