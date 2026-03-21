# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Frigate Review Accelerator — Claude Code Context

## What this project is

A high-performance video review interface that sits alongside Frigate NVR.
It does NOT replace Frigate — it adds fast timeline scrubbing and preview
thumbnails on top of Frigate's existing recordings.

This is a continuous time-based discovery system. It is not a traditional video
player and not a list of clips. The goal is: navigate through time, identify
meaningful moments via events, and verify them via video from any camera.

- **Backend:** FastAPI + SQLite + ffmpeg, port 8100
- **Frontend:** React + Vite, port 5173
- **Host:** Ubuntu server (`nvr`), recordings at `/mnt/frigate-storage/recordings/recordings`

-----

## Interaction phases

All features must support one or more of these phases:

1. **Discovery** — scan through time using event signals
2. **Targeting** — zoom and precisely position in time
3. **Verification** — play video at that time and confirm

-----

## Core architectural invariants — do not violate these

### Scrubbing vs playback (hard separation)

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

### Timeline read-only invariant

GET /api/timeline and GET /api/timeline/buckets are READ-ONLY.
They must never trigger:
  - preview generation
  - ffprobe calls
  - filesystem scans (stat, exists, glob)
  - segment iteration beyond a single bounded DB query

They query existing data only: DB reads and in-memory set lookups.

### Global time invariant

`cursorTs` is the single source of truth for time. All UI elements derive from it.

Time persists across camera switches, filter changes, and UI state changes.
Time is NEVER implicitly changed by the system. Only explicit user action may
modify `cursorTs`.

This supports cross-camera reasoning: "What happened at this moment across cameras?"

### Preview generation is demand-driven, not batch-driven.

Previews exist at multiple temporal resolutions:

- coarse (background): 5–10s intervals, full corpus over time
- interaction (viewport): 1–2s intervals, generated lazily
- precision (reticle): sub-second, generated on demand

The system must never attempt to generate dense previews for the full corpus.

On-demand preview requests generate at most one frame per request.

Batch extraction of multiple frames per segment is not required for correctness
and must not be used as a fallback mechanism.

Preview generation must follow user interaction patterns, not segment boundaries.

### Camera is a filter, not a context switch

Switching cameras MUST NOT change `cursorTs`, `rangeStart`/`rangeEnd`, or zoom level.
Switching cameras MUST update event data and video source.

Camera selection is a filter on data, not a change in context.

### Timeline orientation and coordinate system (design decision)

The timeline is vertical — time flows top to bottom along the y axis. This is a
deliberate design choice: the vertical orientation supports the event-first
discovery workflow, where the reticle sits at a fixed horizontal position and the
user scrolls time past it, similar to a tape transport rather than a scrubber.

Do not refactor toward a horizontal layout. If you encounter horizontal timeline
patterns elsewhere (e.g. in reference code or other Frigate UIs), they are not
the target design for this project.

All timeline elements must derive from a single coordinate mapping:

```
y(t) = (t - startTs) / secondsPerPixel
```

This applies to: ticks, labels, event markers, reticle position.
No alternate mappings. No snapping. No rounding-based positioning.
If two elements represent the same timestamp, they must align pixel-perfectly.

### Reticle model (UX framing and invariant)

**UX framing:** The reticle feels fixed while time flows past it — like a
playhead on a tape transport. This is the intended user mental model.

**Implementation invariant:** The reticle has no independent time value. It
displays the value of the timeline at its position and reads `cursorTs` — it
does not drive it.

```
reticle_time = displayCursorRef.current
```

Do not give the reticle its own state or allow it to get out of sync with
`cursorTs`.

### Scroll interaction model (VerticalTimeline.jsx)

Scroll input is interpreted as velocity, not position. The implementation in
`VerticalTimeline.jsx` uses `scrollVelocityRef` + `decayScroll` with a RAF loop.

Key constants:
- `DAMPING = 0.88` per frame
- `K = 0.22` zoom-aware sensitivity multiplier (seconds-per-pixel scaled)
- delta normalized to 40 max before accumulation
- velocity capped at `range * 0.15` for decay stability

Required behavior — do not regress:
- Small input -> precise movement
- Large input -> momentum + glide
- Release -> smooth deceleration
- New input -> cancels existing decay (`cancelAnimationFrame` before accumulating)
- Sensitivity scales with `secondsPerPixel` — zoomed in is slower and more precise

`Timeline.jsx` (horizontal, used in SplitView) uses scroll-to-zoom, not
scroll-to-pan. That is correct behavior — do not change it.

### No backend coupling in interaction loops

Frontend interaction must NOT trigger database queries, ffmpeg, or filesystem reads.
All interaction runs on existing in-memory state.

-----

## Event system

### Events are the primary signal

Events are how users discover meaning in time. The timeline exists to expose events.

A timeline without event visibility is a non-functional system. Users must always
be able to see events and navigate between them.

### Event data model

Events are Frigate-tracked objects. The label set is whatever Frigate returns for
this installation — it is user-configurable in frigate.yml and must not be
hardcoded or assumed. Render the `label` field from the Frigate events API
response directly. Do not remap, roll up, or filter labels (e.g. do not collapse
"car" and "truck" into "vehicle"). See Frigate events API:
https://docs.frigate.video/integrations/api/events-events-get

### Event timestamp handling

Use fallback chain for resilience:
```
evt.start_ts ?? evt.start_time ?? evt.timestamp
```
`start_ts` is canonical. The fallbacks are for resilience only, not primary logic.

### Event rendering invariant

Events render as ticks on the canvas, independent of density data, preview state,
and autoplay state. Event rendering must never be gated on these other layers.

If events exist but do not render, the system must log a warning — never fail silently.

-----

## Frontend interaction requirements

### Prev/Next navigation is first-class

Must be visible whenever events exist. Must not be hidden or deprioritized.
Must jump to the event timestamp, stop autoplay immediately, and cancel any
active scroll motion.

### Sensitivity scales with zoom

All motion scales with `secondsPerPixel`. This is enforced in `VerticalTimeline.jsx`
via the `K * secondsPerPixel` sensitivity calculation. Zoomed in -> slower, more
precise. Zoomed out -> faster. If zoom levels feel identical in motion speed, the
scaling is broken.

### Precision requirement

Users must be able to stop near an event, then adjust forward/backward precisely,
without jitter, oscillation, or overshoot. If the user cannot make small
adjustments near an event without instability, the implementation is incorrect.

### Visual hierarchy

| Layer    | Role              | Contrast               |
|----------|-------------------|------------------------|
| Events   | Signal            | High — always dominant |
| Reticle  | Active position   | Clear, not dominant    |
| Ticks    | Scale             | Medium                 |
| Grid     | Structure         | Low                    |

Event markers must always be visually dominant. If events are difficult to see,
the visualization is incorrect.

No per-event DOM nodes. Timeline rendering is canvas-based (already enforced
in both Timeline.jsx and VerticalTimeline.jsx — do not regress this).

### No silent rendering failures

If data exists but nothing renders, log a warning. Examples:
- `events.length > 0` but no markers drawn
- unknown or unmapped event label received

### Time format is display-only

12h / 24h toggle affects display only. Never affects timestamps or internal logic.
Default = 12h. No persistence — resets to 12h on page load.

-----

## Time control behavior

**Now:** `cursorTs = nowTs()`. Primary control, not hidden or secondary.

**Direct time navigation:** User sets an explicit timestamp. System sets `cursorTs`
exactly and updates the visible range. No required animation.

**System initialization:** On load, `cursorTs = nowTs()`. Deep-link or query-param
override must be possible (required for v3 direct event linking — see Planned v3
features).

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
        preview.py            # GET /api/preview/{camera}/{ts}  <- HOT PATH
        timeline.py           # GET /api/timeline, /api/playback, /api/health
        admin.py              # GET/POST /api/admin/* (SSE log stream, script runner)
      services/
        indexer.py            # Filesystem walker -> segments table
        preview_generator.py  # ffmpeg frame extractor (timestamp-based, not segment-based)
        worker.py             # Background task: index -> on-demand (timestamp-driven) -> recency -> background
        event_sync.py         # Frigate event poller -> events table
        hls.py                # Frigate VOD URL construction + reachability cache
    requirements.txt
    .env                      # Not in git — copy from .env.example
  frontend/
    src/
      App.jsx                 # All state lives here. Single source of truth.
      components/
        Timeline.jsx          # Canvas-only rendering. Scroll = zoom. HOVER/DRAG/RELEASE state machine.
        VerticalTimeline.jsx  # Canvas-only rendering. Scroll = pan (velocity model). Fixed reticle.
        VideoPlayer.jsx       # Receives PlaybackTarget prop, never does segment math
        CameraSelector.jsx
        AdminPanel.jsx        # SSE log viewer + restart/update/pull buttons
      utils/
        api.js                # All fetch calls. One function per endpoint.
        time.js               # Timestamp formatting helpers
        constants.js          # RETICLE_FRACTION and other shared constants
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

**Frontend -> Backend proxy:** Vite proxies all `/api` requests to `http://localhost:8100`.
This means `api.js` uses relative `/api` paths in dev — no CORS issue during local development.

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
Tier 0 — On-demand   : The on-demand system operates on timestamps, not segments.
Segments are a storage detail, not a unit of work.
Tier 1 — Recency     : segments newer than preview_recency_hours (default 48h)
Tier 2 — Background  : all remaining pending, every BACKGROUND_INTERVAL=10 cycles
```

The `_demand_queue` is an in-process `deque`. **Do not run uvicorn with --workers > 1**
or on-demand requests will silently go to the wrong worker process.

-----
### Preview lookup must be non-blocking

GET /api/preview/{camera}/{ts} must never block on generation.

If a preview does not exist:
- return immediately (404 or placeholder)
- optionally enqueue generation asynchronously

The request path must remain constant-time (O(1)).

### Preview data is a cache, not a source of truth

Previews are an opportunistic cache of visual data over time.

- Missing previews are not errors
- The system must never block on preview availability
- Playback is always the source of truth for verification

The UI must gracefully handle sparse or partial preview coverage.

### No retry amplification

Preview generation must never escalate work on failure.

A failed preview attempt must not trigger:
- multiple fallback subprocesses
- retries across multiple buckets
- recursive or cascading generation

Failure should degrade gracefully (missing preview), not amplify load.

### Interaction-driven prefetch (future-facing invariant)

Preview generation may be guided by user interaction direction.

When the user is actively scrolling:
- generation should prioritize timestamps ahead of the cursor direction
- generation should avoid symmetric expansion around the cursor

This is not required for correctness but is the intended optimization direction.

### Scroll stability invariant

Scroll interaction must never overshoot beyond user control.

- Velocity must decay smoothly
- Input must remain interruptible at all times
- The user must always be able to "catch" and stop near a target timestamp

If the user cannot reliably stop near an event, the implementation is incorrect.

Preview generation is driven by time, not storage layout.
Segments are an implementation detail and must not shape interaction behavior.

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

## Frigate docs usage — verify before changing Frigate-facing behavior

Before modifying any code that depends on Frigate behavior, Claude Code must check the
official Frigate docs first and cite the relevant page in the PR description or commit notes.

This applies especially to:
- recording path/layout
- VOD / playback endpoints
- event/review API behavior
- preview/snapshot/media endpoints
- retention and recording semantics
- Home Assistant / MQTT integration assumptions

Primary doc areas:
- Recording: https://docs.frigate.video/configuration/record/
- HTTP API index: https://docs.frigate.video/integrations/api/frigate-http-api/
- Events API: https://docs.frigate.video/integrations/api/events-events-get/
- VOD Hour API: https://docs.frigate.video/integrations/api/vod-hour-vod-year-month-day-hour-camera-name-tz-name-get/
- Recordings summary API: https://docs.frigate.video/integrations/api/all-recordings-summary-recordings-summary-get/
- Snapshot from recording API: https://docs.frigate.video/integrations/api/get-snapshot-from-recording-camera-name-recordings-frame-time-snapshot-format-get/

Do not rely on memory alone for Frigate API or path assumptions.

-----

## Real deployment assumptions for this repo

This project is built against a real Frigate installation with:
- recordings enabled
- MQTT enabled
- go2rtc in use
- multiple cameras with mixed Dahua + Ubiquiti sources
- detect streams often separate from record streams
- Frigate API reachable at http://localhost:5000 on host nvr

Important:
- Never assume all cameras have the same stream topology
- Never assume audio is present on all cameras
- Never assume detect and record use the same stream
- Never assume previews should be generated for the full historical corpus

-----

## Preview generation policy

Indexing may cover the full historical corpus.
Preview generation must never eagerly process the full corpus by default.

Preview generation priorities:
1. on-demand windows the user is actively viewing
2. recent segments within PREVIEW_RECENCY_HOURS
3. low-rate background fill for older gaps

Do not enqueue the full database for preview generation on startup.
Do not regress to "generate every preview for every segment" behavior.
Any PR touching worker.py or preview_generator.py must preserve this policy.

-----

## Frigate config facts relevant to this project

Current Frigate installation characteristics:
- MQTT enabled
- recordings enabled
- semantic_search enabled
- birdseye enabled
- Frigate VOD playback available
- multiple review labels and zones per camera
- mixed camera fleet with go2rtc restreaming
- several cameras use separate detect substreams and record main streams
- hardware acceleration enabled via Intel QSV
- Frigate version currently tracked in local config

Design implications:
- timeline/event UX should expect rich review metadata
- playback compatibility may vary by stream/audio codec
- frontend should prefer Frigate APIs for media/navigation when they are more efficient than local reconstruction
- APIs should not assume all cameras support the same enrichments (audio, face recognition, genai, etc.)

-----

## Secrets and local environment safety

Never commit secrets, tokens, IP-specific credentials, or copied production .env values.
Never include actual camera credentials, MQTT passwords, API keys, or private RTSP URLs in PRs, tests, or docs.
When examples are needed, use placeholders.

-----

## Planned v3 features

1. **HLS window extension** — When playback reaches within 60s of the end of the
   current HLS window, fetch a new PlaybackTarget centered on the current absoluteTs
   and reload the hls.js source. This gives effectively unlimited continuous playback.
   Add onWindowExhausting(currentTs) callback from VideoPlayer -> App.jsx.

2. **Frigate event sync paging** — event_sync.py fetches one page of 100 events.
   If a camera has >100 new events since last sync, older ones are silently skipped.
   Fix: paginate using Frigate's after/before params until response length < _LIMIT.

3. **Preview retention verification** — At 2s intervals, 9 cameras, 30 days:
   ~175GB of preview JPEGs. Confirm delete_old_previews runs and verify disk usage
   is stable before increasing preview_retention_days.

4. **Deep-link / query-param time targeting** — Allow cursorTs to be set via URL
   parameter on load, overriding the default nowTs() initialization. Required for
   direct event linking and future notification integrations.

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

## Claude chat <-> Claude Code workflow

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

The stable dep chain is: `destroyHls: []` -> `loadHls: [destroyHls]` ->
`extendHlsWindow: [camera, loadHls]` -> `handleTimeUpdate: [playbackTarget, onTimeUpdate, extendHlsWindow]`
-> `handleEnded: [playbackTarget, onSegmentAdvance, displayTime, extendHlsWindow]`.

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

-----

## Workflow: Claude Chat -> Claude Code

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
