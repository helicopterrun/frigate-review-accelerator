# Frigate Review Accelerator

A high-performance video review interface that sits alongside Frigate NVR, delivering near-instant timeline scrubbing and playback.

**Does not replace Frigate.** It augments it with a preview-first review UX.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Frigate NVR (unchanged)                        │
│  - Camera ingest, detection, recording          │
│  - Stores segments: /media/frigate/recordings/  │
│  - API at http://frigate:5000                   │
└──────────────┬──────────────────────────────────┘
               │ reads segments + API
┌──────────────▼──────────────────────────────────┐
│  Accelerator Backend (FastAPI)                  │
│  - Indexes recording segments                   │
│  - Generates preview thumbnails (ffmpeg)        │
│  - Serves timeline + preview APIs               │
│  - SQLite for metadata                          │
│  Port 8100                                      │
└──────────────┬──────────────────────────────────┘
               │ REST API
┌──────────────▼──────────────────────────────────┐
│  Accelerator Frontend (React + Vite)            │
│  - Canvas timeline with thumbnail scrubbing     │
│  - Click-to-seek MP4 playback                   │
│  - Event overlays from Frigate                  │
│  Port 5173                                      │
└─────────────────────────────────────────────────┘
```

## Core Principle

**Scrubbing = image lookup. Playback = video decode.**

These two operations are never mixed. Scrubbing uses precomputed JPEG
thumbnails served from disk/memory. Video decode only happens after the
user settles on a timestamp and hits play.

## Quick Start

### Prerequisites
- Frigate NVR running with recordings enabled
- Python 3.11+
- Node.js 20+
- ffmpeg + ffprobe on PATH

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env with your Frigate paths

# Initialize DB + run initial index
python -m app.services.indexer

# Start server
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

## Configuration (.env)

| Variable | Description | Default |
|---|---|---|
| `FRIGATE_RECORDINGS_PATH` | Path to Frigate recordings dir | `/media/frigate/recordings` |
| `FRIGATE_API_URL` | Frigate API base URL | `http://localhost:5000` |
| `PREVIEW_OUTPUT_PATH` | Where to store generated thumbnails | `./data/previews` |
| `DATABASE_PATH` | SQLite database location | `./data/accelerator.db` |
| `PREVIEW_INTERVAL_SEC` | Seconds between preview frames | `2` |
| `PREVIEW_WIDTH` | Thumbnail width in pixels | `320` |
| `PREVIEW_QUALITY` | JPEG quality (1-31, lower=better) | `5` |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/cameras` | List indexed cameras |
| GET | `/api/timeline` | Segments, gaps, events, activity density |
| GET | `/api/playback` | Resolve timestamp → segment + offset + stream URL |
| GET | `/api/preview/{camera}/{ts}` | O(1) bucket lookup → JPEG (hot path) |
| GET | `/api/preview-strip/{camera}` | Batch of preview frame URLs for range |
| GET | `/api/preview/stats` | LRU cache hit rate diagnostics |
| GET | `/api/segment/{id}/stream` | Stream MP4 segment for playback |
| POST | `/api/index/scan` | Trigger re-scan of recordings |
| GET | `/api/health` | Health check |

## Preview Alignment (important)

Preview filenames ARE the globally-aligned bucket timestamps (e.g. `1700000004.00.jpg`).
The scrub hot path does pure math to find them — no database query.

After generating previews, validate alignment:
```bash
python -m scripts.validate_previews
```

If misaligned: delete `data/previews/`, reset DB (`UPDATE segments SET previews_generated=0`),
and re-run the generator.

## Project Status

- [x] Project scaffold
- [x] Segment indexer (filesystem walk + ffprobe)
- [x] Preview frame generator (globally-aligned buckets)
- [x] Timeline API (segments, gaps, events, activity density)
- [x] Preview serving (O(1) bucket + LRU cache)
- [x] /api/playback endpoint (backend-resolved seek target)
- [x] Frontend timeline component (canvas, no DOM during drag)
- [x] Scrubbing UX (HOVER/DRAG/RELEASE state machine)
- [x] Playback integration (PlaybackTarget + next segment preload)
- [x] Event overlay (colored markers by label)
- [x] Activity heatmap (bucketized event density)
- [x] Gap detection + visualization (hatched regions)
- [ ] Frigate event sync (periodic /api/events poll)
- [ ] Timeline zoom (scroll to zoom time range)
- [ ] Phase 3: MSE stitching / go2rtc gapless playback
