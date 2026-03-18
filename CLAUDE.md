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

```bash
# Backend
cd backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload

# Frontend (separate terminal)
cd frontend
npm run dev

# Or use the scripts (after first manual setup):
./scripts/restart.sh
./scripts/logs.sh --previews    # watch preview generation
./scripts/logs.sh --status      # snapshot of worker state
```

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

-----

## Known bugs to fix (v2)

### 1. Playback cursor drift  ← fix this first

`VideoPlayer.handleEnded` auto-advances segments by swapping video src directly.
`playbackTarget` in `App.jsx` is never updated. After crossing a segment boundary,
`absoluteTs = playbackTarget.segment_start_ts + video.currentTime` uses the old
segment’s start_ts and the timeline cursor drifts by one full segment duration.

**Fix:** Add `onSegmentAdvance(nextSegmentId)` prop to VideoPlayer. On segment end,
call it instead of swapping src. In App.jsx fetch `/api/playback` for the new
segment and update `playbackTarget` state.

### 2. Full filesystem scan every 30s

`scan_recordings_dir` does `root.rglob("*.mp4")` on every worker cycle.
`scan_state` table exists but is never written to.

**Fix:** Write `last_scanned_ts` per camera to `scan_state` after each scan.
Use `os.scandir` + `st_mtime` filtering on subsequent cycles. Full rglob only
on first run (empty `scan_state`).

### 3. One ffmpeg subprocess per preview frame

`_extract_frame_at_offset` is called in a loop. 5 subprocesses per segment,
~7.5M total at current scale.

**Fix:** Single ffmpeg call per segment using the `select` filter. Write to
temp dir, rename to aligned bucket timestamps, move to final location.
Keep single-frame as fallback.

### 4. Minor

- `asyncio.get_event_loop()` → `asyncio.get_running_loop()` (deprecated 3.10+)
- CORS origins hardcoded in main.py → use `settings.cors_origins`
- `logs/` and `.pids/` missing from `.gitignore`
- Admin panel restart button gets stuck when uvicorn kills itself mid-stream
  (fetch errors before `done` SSE fires) — show reconnect state + poll `/api/health`

-----

## Planned v2 features

1. **Timeline zoom** — scroll wheel zooms time range centred on cursor. Min 15m, max 7d.
   Add `onRangeChange(newStart, newEnd)` callback. Range state stays in App.jsx.
1. **Frigate event sync** — new `backend/app/services/event_sync.py`.
   Poll `GET {frigate_api}/api/events`, upsert into `events` table,
   track `last_event_sync_ts` in `scan_state`. Run in worker after indexing.
   This makes the event overlay markers on the timeline actually populate.
1. **Per-camera preview progress** — `GET /api/preview/progress` returning
   `[{camera, total_segments, previews_done, pending_recent, pending_historical}]`.
   Progress bars in AdminPanel status tab.
1. **Preview retention cleanup** — delete previews older than `preview_retention_days`
   (default 30). Background job, runs once daily in small batches.

-----

## Testing

No tests exist yet. When writing tests:

```
backend/tests/
  unit/
    test_indexer.py        # parse_segment_path, _global_bucket_timestamps
    test_preview.py        # _quantize_ts, _bucket_path — the O(1) invariants
    test_timeline.py       # _compute_gaps, _compute_activity, coverage_pct
  integration/
    test_api.py            # httpx AsyncClient against real in-memory SQLite
    conftest.py            # fixtures
```

Most critical tests (write these first):

```python
test_quantize_ts_alignment()     # bucket math must be globally aligned — everything depends on this
test_global_bucket_timestamps()  # boundary conditions, empty range
test_parse_segment_path_valid()  # indexer foundation
test_gap_detection()             # gaps drive timeline rendering
test_playback_gap_snapping()     # ts in gap → nearest segment, not 404
test_preview_no_db_on_hit()      # mock get_db — assert never called on cache hit
```

Use `pytest` + `pytest-asyncio` + `httpx.AsyncClient`.
Use SQLite `:memory:` for integration tests.
Mock `subprocess.run` at the boundary in unit tests — never call real ffmpeg.

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