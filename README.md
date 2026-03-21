# Frigate Review Accelerator

A high-performance video review interface that sits alongside [Frigate NVR](https://frigate.video), adding fast timeline scrubbing, event navigation, and preview thumbnails on top of Frigate’s existing recordings.

**Does not replace Frigate.** It augments it with a preview-first review workflow.

-----

## What problem does this solve?

Frigate stores recordings as short MP4 segments (typically ~10s each). Reviewing footage across many cameras over hours of time means seeking through hundreds of files. The Accelerator adds:

- A vertical scrolling timeline where time flows under a fixed reticle
- Preview thumbnails extracted from recordings, served in O(1) — no database query per scrub event
- Event overlays pulled from Frigate’s detection events API
- Density heatmaps showing where detections cluster across time
- Click-to-seek HLS playback via Frigate’s VOD API

### Core design principle

```
Scrubbing = image lookup.   Playback = video decode.   Never mix them.
```

Preview filenames **are** their timestamps (`1700000004.00.jpg`). Lookup is pure math — no database query on the hot path. See `CLAUDE.md` for the full set of architectural invariants.

-----

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Frigate NVR (unchanged)                        │
│  - Camera ingest, detection, recording          │
│  - Stores segments: recordings/YYYY-MM-DD/HH/   │
│  - API at http://frigate:5000                   │
│  - VOD at /api/vod/{camera}/start/{t}/end/{t}   │
└──────────────┬──────────────────────────────────┘
               │ reads segments + API
┌──────────────▼──────────────────────────────────┐
│  Accelerator Backend (FastAPI, port 8100)       │
│  - Indexes recording segments into SQLite       │
│  - Generates preview JPEGs via ffmpeg           │
│  - Syncs Frigate events periodically            │
│  - Serves timeline, preview, and playback APIs  │
└──────────────┬──────────────────────────────────┘
               │ REST + SSE
┌──────────────▼──────────────────────────────────┐
│  Accelerator Frontend (React + Vite, port 5173) │
│  - Vertical canvas timeline (time flows top→bottom)│
│  - Scrub preview overlay on VideoPlayer         │
│  - HLS playback via Frigate VOD API             │
│  - Event navigation with prev/next controls     │
│  - Ops/Admin panel with live log stream         │
└─────────────────────────────────────────────────┘
```

-----

## Prerequisites

- **Frigate NVR** running with recordings enabled. See [Frigate recording configuration](https://docs.frigate.video/configuration/record/).
- **Python 3.11+**
- **Node.js 20+**
- **ffmpeg** and **ffprobe** on `PATH`

The backend talks to Frigate’s HTTP API for events and VOD playback. See the [Frigate HTTP API index](https://docs.frigate.video/integrations/api/frigate-http-api/) for the full reference. The specific endpoints used are:

- [Events API](https://docs.frigate.video/integrations/api/events-events-get/) — polled periodically for detection events
- [VOD API](https://docs.frigate.video/integrations/api/vod-hour-vod-year-month-day-hour-camera-name-tz-name-get/) — used for HLS playback via `/api/vod/{camera}/start/{t}/end/{t}`

-----

## Quick Start

### 1. Configure

```bash
cd backend
cp .env.example .env
# Edit .env — set FRIGATE_RECORDINGS_PATH and FRIGATE_API_URL at minimum
```

### 2. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

### Or use the management scripts (after first manual setup)

```bash
./scripts/update.sh          # install/update all deps
./scripts/restart.sh         # start backend + frontend
./scripts/restart.sh --stop  # stop everything
./scripts/logs.sh            # tail both logs
./scripts/logs.sh --status   # worker status snapshot
```

-----

## Configuration (.env)

|Variable                    |Description                                         |Default                        |
|----------------------------|----------------------------------------------------|-------------------------------|
|`FRIGATE_RECORDINGS_PATH`   |Path to Frigate recordings directory                |`/media/frigate/recordings`    |
|`FRIGATE_API_URL`           |Frigate API base URL                                |`http://localhost:5000`        |
|`PREVIEW_OUTPUT_PATH`       |Where to store generated thumbnails                 |`./data/previews`              |
|`DATABASE_PATH`             |SQLite database path                                |`./data/accelerator.db`        |
|`PREVIEW_INTERVAL_SEC`      |Seconds between preview frames                      |`2`                            |
|`PREVIEW_WIDTH`             |Thumbnail width in pixels                           |`320`                          |
|`PREVIEW_QUALITY`           |JPEG quality (1–31, lower = better)                 |`5`                            |
|`PREVIEW_RECENCY_HOURS`     |Eagerly generate previews within this window        |`168`                          |
|`PREVIEW_BACKGROUND_ENABLED`|Crawl older segments in the background              |`true`                         |
|`PREVIEW_BACKGROUND_BATCH`  |Segments per background crawl cycle                 |`100`                          |
|`SCAN_INTERVAL_SEC`         |Seconds between background worker cycles            |`30`                           |
|`IMPORTANT_LABELS`          |Labels triggering amber density markers             |`["cat","bird","bear","horse"]`|
|`FRIGATE_VOD_ENABLED`       |Use Frigate HLS VOD for playback                    |`true`                         |
|`PREVIEW_RETENTION_DAYS`    |Delete previews older than N days (0 = keep forever)|`30`                           |
|`CORS_ORIGINS`              |Allowed frontend origins                            |`["http://localhost:5173"]`    |


> **Important:** Do **not** run uvicorn with `--workers > 1`. The on-demand preview queue and HLS reachability cache are in-process singletons. See `CLAUDE.md` for details.

-----

## Project Structure

```
frigate-review-accelerator/
  backend/
    app/
      config.py               # All settings via pydantic-settings / .env
      main.py                 # FastAPI app, lifespan, CORS, router mounts
      models/
        database.py           # SQLite schema, WAL mode, get_db() context manager
        schemas.py            # Pydantic request/response models
      routers/
        preview.py            # GET /api/preview/{camera}/{ts}  ← HOT PATH (O(1))
        timeline.py           # GET /api/timeline, /api/playback, /api/health, density
        admin.py              # SSE log stream, restart/update/pull/reindex endpoints
      services/
        indexer.py            # Filesystem walker → segments table
        preview_generator.py  # ffmpeg single-frame extractor (timestamp-based)
        preview_scheduler.py  # Priority queue: VIEWPORT → NEAR_VIEWPORT → RECENT → BACKGROUND
        worker.py             # Background loop: index → events → scheduler → on-demand → recency → background
        event_sync.py         # Frigate events poller with pagination
        hls.py                # Frigate VOD URL construction + reachability cache
        time_index.py         # TimeIndex singleton: bucket math, density, resolution selection
    requirements.txt
    .env                      # Not in git — copy from .env.example
    tests/
      unit/                   # Pure unit tests (no DB, no network)
      integration/            # httpx AsyncClient against in-memory SQLite
  frontend/
    src/
      App.jsx                 # All state lives here — single source of truth
      components/
        VerticalTimeline.jsx  # Canvas timeline, scroll-to-pan (velocity model), fixed reticle
        VideoPlayer.jsx       # HLS via hls.js or MP4 segment fallback
        Timeline.jsx          # Horizontal canvas timeline (SplitView only, scroll-to-zoom)
        CameraSelector.jsx    # Single or multi-select
        AdminPanel.jsx        # Ops drawer: logs, status, progress, reindex
        SplitView.jsx         # 2–4 camera simultaneous view
      utils/
        api.js                # All fetch calls
        time.js               # Timestamp formatting + bucketSizeForRange()
        constants.js          # RETICLE_FRACTION
  scripts/
    restart.sh                # Start/stop uvicorn + vite
    update.sh                 # git pull + pip install + npm install
    logs.sh                   # Tail + filter logs with colour coding
    smoke_test.sh             # Post-restart sanity check
```

-----

## How It Works

### Segment indexing

On startup and every `SCAN_INTERVAL_SEC` seconds, the background worker scans Frigate’s recording directory. Frigate stores recordings in a well-defined structure:

```
{recordings_root}/{YYYY-MM-DD}/{HH}/{camera}/{MM}.{SS}.mp4
```

The indexer parses timestamps directly from the path — no ffprobe needed for the initial index pass. See `backend/app/services/indexer.py`.

### Preview generation

The worker uses a three-tier priority model:

1. **Tier 0 — On-demand:** Timestamps the frontend is actively viewing. Drained first every cycle.
1. **Tier 1 — Recency:** Segments within `PREVIEW_RECENCY_HOURS` (default 7 days). One frame per segment, newest first.
1. **Tier 2 — Background:** All remaining unprocessed segments. Runs every `BACKGROUND_INTERVAL` cycles.

Preview generation is **never** batch-driven and **never** eagerly processes the full corpus. One ffmpeg subprocess per request, one output frame. See `CLAUDE.md` — “Preview generation invariants.”

### O(1) preview lookup

```python
bucket_ts = round(ts / interval) * interval
path = preview_output_path / camera / YYYY-MM-DD / f"{bucket_ts:.2f}.jpg"
```

No database query. The filename **is** the timestamp. This is the invariant that makes scrubbing fast at 60fps. If you add a DB call to `GET /api/preview/{camera}/{ts}` you have broken the design.

### Event sync

The worker polls `GET /api/events` on the Frigate API after each index pass, using the [Frigate events API](https://docs.frigate.video/integrations/api/events-events-get/). Events are paginated — if a camera has more than 100 new events since last sync, the sync walks pages until caught up. Events are cached locally in the `events` table and overlaid on the timeline canvas.

### HLS playback

Playback uses Frigate’s VOD endpoint:

```
{frigate_api_url}/api/vod/{camera}/start/{window_start}/end/{window_end}
```

The backend builds a 24-hour window so playback can continue across segment boundaries without reloading. See `backend/app/services/hls.py` and the [Frigate VOD API docs](https://docs.frigate.video/integrations/api/vod-hour-vod-year-month-day-hour-camera-name-tz-name-get/).

When Frigate is unreachable, the backend falls back to serving MP4 segments directly via `/api/segment/{id}/stream`.

-----

## API Reference

|Method|Path                        |Description                                               |
|------|----------------------------|----------------------------------------------------------|
|GET   |`/api/cameras`              |List indexed cameras with stats                           |
|GET   |`/api/timeline`             |Segments, gaps, events, activity density for a time range |
|GET   |`/api/timeline/density`     |Lightweight per-bucket tracked-object counts (for panning)|
|GET   |`/api/timeline/buckets`     |Time-indexed bucket coverage (has_preview + event density)|
|GET   |`/api/playback`             |Resolve timestamp → segment + offset + HLS URL            |
|GET   |`/api/preview/{camera}/{ts}`|O(1) bucket lookup → JPEG (scrub hot path)                |
|POST  |`/api/preview/request`      |On-demand generation hint for a time window               |
|GET   |`/api/preview/stats`        |LRU cache hit rate diagnostics                            |
|GET   |`/api/preview/progress`     |Per-camera preview generation progress                    |
|GET   |`/api/segment/{id}/stream`  |Stream MP4 segment (fallback when VOD unavailable)        |
|GET   |`/api/segment/{id}/info`    |Segment metadata + stream URLs                            |
|POST  |`/api/index/scan`           |Trigger manual re-scan                                    |
|GET   |`/api/health`               |System health check                                       |
|GET   |`/api/admin/status`         |Worker status snapshot                                    |
|GET   |`/api/admin/logs/stream`    |SSE live log stream                                       |
|POST  |`/api/admin/restart`        |Restart backend worker (SSE output)                       |
|POST  |`/api/admin/reindex`        |Targeted reindex from N hours ago (SSE progress)          |

-----

## Database Schema

SQLite with WAL mode. All timestamps are Unix floats (seconds since epoch).

```sql
segments     — one row per Frigate MP4 recording segment
  id, camera, start_ts, end_ts, duration, path, file_size, indexed_at
  previews_generated  INTEGER  0=pending  1=processed (success or failure)

previews     — one row per extracted JPEG preview
  id, camera, ts, segment_id, image_path, width, height

events       — cached Frigate detections
  id, camera, start_ts, end_ts, label, score, has_clip, has_snapshot, synced_at
  zones  TEXT  -- JSON list of zone names

scan_state   — last scan position per camera (incremental indexing)
  camera, last_scanned_ts, last_file_path, last_event_sync_ts
```

-----

## Running Tests

```bash
cd backend

# All tests
pytest

# Single file
pytest tests/unit/test_preview.py -v

# With coverage
pytest --cov=app tests/
```

Tests use `pytest-asyncio` and `httpx.AsyncClient` against in-memory SQLite. Never call real ffmpeg in tests — mock `subprocess.run` at `app.services.preview_generator.subprocess.run`.

-----

## Current Production State (March 2026)

- ~1,489,685 segments across 9 cameras on the reference installation
- Backend and frontend both stable
- HLS VOD playback via Frigate’s `/api/vod/` API (hls.js in frontend)
- MP4 segment fallback when Frigate VOD is unreachable
- Intel VAAPI hardware decode for preview extraction (falls back to software)
- Admin panel operational: live log stream, restart, git pull, targeted reindex
- Event sync with pagination (handles cameras with >100 new events per cycle)

-----

## Known Issues

**HLS seek offset edge case (low priority):** The seek offset into the HLS window is capped at 30s. If `requested_ts - seg_start > 30`, the cap fires and playback starts slightly before the requested position. Frigate segments are ~10s so this never triggers in practice.

**HLS reachability cache is process-local:** `_hls_reachable_cache` lives in the uvicorn process. Do not run uvicorn with `--workers > 1`.

-----

## Planned Features (v3)

1. **HLS window extension** — seamless continuous playback as the 24h window approaches its end
1. **Deep-link / query-param time targeting** — `?ts=N&camera=X` for direct event linking
1. **Preview retention verification** — confirm `delete_old_previews` is keeping disk usage stable at scale

See `CLAUDE.md` — “Planned v3 features” for full spec.

-----

## Deployment Notes

The Vite dev server proxies all `/api` requests to `http://localhost:8100`. For production, build the frontend and serve it behind nginx with the same proxy config. See `frontend/nginx.conf` and `frontend/Dockerfile`.

The backend `Dockerfile` installs ffmpeg and runs uvicorn directly. The frontend `Dockerfile` builds with Vite and serves via nginx.

Never commit `.env`, `data/`, `logs/`, or `previews/`. See `.gitignore`.

-----

## See Also

- [`CLAUDE.md`](CLAUDE.md) — Full architectural invariants, design decisions, and development workflow. **Read this before making any changes.**
- [Frigate NVR documentation](https://docs.frigate.video)
- [Frigate recording configuration](https://docs.frigate.video/configuration/record/)
- [Frigate HTTP API reference](https://docs.frigate.video/integrations/api/frigate-http-api/)