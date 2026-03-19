# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Frigate Review Accelerator — Claude Code Context

## What this project is

A high-performance video review interface that sits alongside Frigate NVR.
It does NOT replace Frigate — it adds fast timeline scrubbing and preview
thumbnails on top of Frigate’s existing recordings.

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
so this never triggers in practice, but it’s worth noting.

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

## Claude chat ↔ Claude Code workflow

**Claude.ai (chat):** Diagnose bugs, design solutions, write Claude Code prompts.
When a fix is agreed on, output a ready-to-paste Claude Code prompt that includes:
root cause, exact files and line-level changes, invariants to preserve, test
requirements, and PR instructions (branch name, title, body).

**Claude Code:** Receive the prompt from chat, implement the changes exactly as
specified, run `pytest` to verify nothing regressed, then create a PR. Do not
open PRs without running tests first.

This split means chat handles the "what and why", Code handles the "how and when".
Skip re-explaining context that's already in this file or in the prompt.

-----

## VideoPlayer.jsx closure hygiene

All callbacks that depend on the `camera` prop must list it (or a useCallback
that captures it) in their dep arrays. Stale `camera` closures cause the player
to fetch a PlaybackTarget for the wrong camera and load it, producing a visible
camera switch. This file has been bitten by this twice.

The stable dep chain is: `destroyHls: []` → `loadHls: [destroyHls]` →
`extendHlsWindow: [camera, loadHls]` → `handleTimeUpdate: [playbackTarget, onTimeUpdate, extendHlsWindow]`
→ `handleEnded: [playbackTarget, onSegmentAdvance, displayTime, extendHlsWindow]`.

Do not flatten any of these to plain functions or remove `camera` from
`extendHlsWindow`'s dep array.

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