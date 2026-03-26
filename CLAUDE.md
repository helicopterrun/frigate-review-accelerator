# Frigate Review Accelerator — CLAUDE.md

This file is the primary orientation document for AI-assisted development on this project. Read it before making any code changes or architectural decisions.

---

## Project Overview

**Frigate Review Accelerator** is a realtime, timeline-driven video review system built on top of Frigate NVR. It presents a continuous 60-slot timeline of camera footage, using a combination of deterministic frame extraction and semantic object detection to help users efficiently navigate and review surveillance footage.

The system is **not** a clip player. It is a time-based discovery interface. The core UX concept is a scrollable, zoomable timeline where each slot represents a time bucket and displays the most relevant frame for that period — either an exact frame (Type A) or the best semantically-scored object detection snapshot (Type B).

---

## Repository Structure

```
frigate-review-accelerator/
├── apps/
│   ├── core-server/          # TypeScript Node.js backend (orchestration, state, transport)
│   ├── frontend/             # React + Pixi.js UI (TypeScript)
│   └── media-service/        # Python FastAPI service (FFmpeg, frame extraction, media cache)
├── packages/
│   └── shared-types/         # Shared TypeScript type definitions (used by frontend AND core-server)
├── docs/
│   └── IMPLEMENTATION_NOTES.md
├── package.json              # Monorepo root
└── tsconfig.base.json
```

---

## Architecture: The Fundamental Split

**This is the most important rule in the project.**

| Layer | Owns | Does NOT own |
|---|---|---|
| **TypeScript core-server** | Timeline engine, slot generation, viewport math, Type B resolver, SemanticIndex, MQTT ingest, HTTP backfill, dirty slot invalidation, SlotScheduler, playback state machine, SQLite persistence, Socket.IO transport | FFmpeg execution, media file management, frame extraction |
| **Python media-service** | FFmpeg frame extraction, preview generation, clip preparation, disk media cache | Timeline logic, semantic ranking, scheduler policy, SQLite writes |
| **Frontend** | User interaction intent (viewport position, filters, playback requests) | Slot resolution logic, semantic scoring, server state |
| **Frigate NVR** | Object detection, tracking, best snapshot selection, review lifecycle, recordings storage | Viewport math, per-slot ranking, UI policies |

**The boundary rule:** TypeScript core decides *what* media is needed and *when*. Python media-service decides *how* to extract or prepare it.

The frontend communicates with the TypeScript core only — never directly with Python for control flow.

---

## ADR Summary

All architectural decisions are locked unless explicitly revisited. Do not work around these.

| ADR | Decision | Rationale |
|---|---|---|
| ADR-001 | TypeScript core + Python media service | Shared types with frontend; clean separation of coordination vs. FFmpeg work |
| ADR-002 | Socket.IO for frontend ↔ core realtime transport | Named events, built-in reconnect, cleaner than raw WebSockets for this event-driven model |
| ADR-003 | SQLite from day one (TypeScript core only) | Persistence from the start avoids recovery complexity and architecture churn later |
| ADR-004 | 60-slot deterministic timeline model | Stable indices, deterministic cache keys, predictable invalidation |
| ADR-005 | Type B preferred, with Type A as fallback — zoom-dependent | At tight zoom (`tWheel < 5 minutes`), Type A only; at wider zoom, Type B preferred with Type A fallback |
| ADR-006 | Frigate MQTT + HTTP hybrid integration | MQTT for realtime freshness; HTTP for history, backfill, and recovery |

---

## Timeline Model

The timeline is always exactly **60 slots** wide. All slot math derives from three parameters the client sends:

```
tCursor   — center time of the viewport
tWheel    — total time span of the viewport
cSlots    — number of slots (default: 60)
```

Derived values:
```
tDiv       = tWheel / cSlots
tViewStart = tCursor - (tWheel / 2)
tViewEnd   = tCursor + (tWheel / 2)

For slot i:
  tSlotStart  = tViewStart + (i * tDiv)
  tSlotEnd    = tSlotStart + tDiv
  tSlotCenter = (tSlotStart + tSlotEnd) / 2
```

All time ranges use **half-open intervals**: `[tSlotStart, tSlotEnd)`.

**The frontend sends viewport parameters. The TypeScript core computes all slot boundaries. Resolvers operate on slot definitions, not arbitrary timestamps.**

### Zoom-Level Frame Strategy

| tWheel | tDiv | Frame Priority | Always Show | Priority | Fallback |
|---|---|---|---|---|---|
| 4s | ~0.067s | Time Accuracy | Type A | — | — |
| 1 min | 1s | Time Accuracy | Type A | — | — |
| 2 min | 2s | Time Accuracy | Type A | — | — |
| **5 min** | **5s** | **Snapshot (semantic)** | — | **Type B** | **Type A** |
| 10 min | 10s | Snapshot | — | Type B | Type A |
| 15 min – 24h+ | varies | Snapshot | — | Type B | Type A |

The 5-minute boundary is the **semantic regime threshold**. Below it, use Type A only.

---

## Frame Types

**Type A** — Deterministic frame extraction
- FFmpeg seek to exact timestamp from Frigate recordings
- Used at tight zoom and as universal fallback
- Executed by Python media-service
- Always must be available

**Type B** — Semantic best-candidate
- Highest-scoring Frigate object detection snapshot within the slot's time bucket
- Filtered by: camera, object label, zone, confidence threshold
- Selected by TypeBResolver in the TypeScript core
- Only used when `tWheel >= 5 minutes`

---

## Resolution Policy

```
resolve(slot):
  if tWheel < 5 minutes:
    return Type A

  candidate = tryTypeB(slot)
  if candidate.valid and candidate.score >= threshold:
    return Type B
  else:
    return Type A
```

Type B scoring weights (initial, tune against real data):
```
0.24 * snapshotScore
+ topScore weight
+ areaScore weight
+ zoneMatchScore
+ labelMatchScore
+ motionScore (0.15 if stationary, 1.0 otherwise)
+ enrichmentBonus
+ timeCenterProximity
+ reviewBonus
```

Candidate eligibility requirements:
1. Camera must be in the active camera filter
2. Entity must overlap slot range `[tSlotStart, tSlotEnd)`
3. Must match object and zone filters if set
4. Confidence must meet active threshold
5. Must have a usable snapshot or media path

---

## Dirty Slot Model

Slot states: `clean → dirty → resolving → clean`

A slot becomes dirty when:
- A new MQTT event overlaps its time range
- An object score or snapshot is updated via MQTT
- Active filters change (all visible slots go dirty)
- Viewport zoom changes (all slots go dirty)
- A slot cache entry is evicted

Rules:
- Only affected slots are invalidated (range-based)
- Dirty slots are always higher priority than prefetch
- Dirty slots resolve in-place — no UI blocking
- Latest resolution result wins
- On failure: fall back to Type A; throttle retries on repeated failure

---

## Playback State Machine

| State | Description |
|---|---|
| `LIVE_STREAM` | tCursor follows wall clock; forward prefetch only; Type B prioritized |
| `SCRUBBING` | User dragging; Type A preferred; no blocking ops; defer heavy scoring |
| `SCRUB_REVIEW` | User stopped; refine to Type B; bidirectional prefetch |
| `PLAYBACK_RECORDING` | Cursor advances automatically; sequential frame priority |
| `FOLLOW_NOW_IDLE` | Near present, paused; no auto-follow |

Transitions:
```
LIVE_STREAM → SCRUBBING        (drag begins)
SCRUBBING → SCRUB_REVIEW       (drag ends)
SCRUB_REVIEW → PLAYBACK_RECORDING (play request)
PLAYBACK_RECORDING → SCRUB_REVIEW (pause)
SCRUB_REVIEW → LIVE_STREAM     (jump to now)
FOLLOW_NOW_IDLE → LIVE_STREAM  (resume)
```

**Scheduler priority order:** `VISIBLE > DIRTY > PREFETCH_FORWARD > PREFETCH_BACKWARD`

---

## Socket.IO Event Contract

### Client → Server

| Event | Purpose |
|---|---|
| `viewport:subscribe` | Initial subscribe or reconnect; sends tCursor, tWheel, cSlots, filters, clientState |
| `viewport:update` | Cursor/zoom/interaction state changed |
| `filters:update` | Object, zone, or confidence filters changed |
| `playback:request` | Request play mode with start time |
| `playback:stop` | Stop playback |
| `debug:toggle` | Dev only: enable debug telemetry |

### Server → Client

| Event | Purpose |
|---|---|
| `viewport:subscribed` | Confirms subscription; echoes normalized state + playbackState + semanticFreshness |
| `slot:resolved` | Per-slot delta; includes slotIndex, resolvedStrategy (A\|B), mediaUrl, score, cacheHit |
| `slots:batch_resolved` | Multiple slots ready together |
| `slot:dirty` | Single slot invalidated |
| `slots:dirty` | Multiple slots invalidated |
| `playback:state` | Authoritative playback state update |
| `semantic:freshness` | MQTT health: `live`, `recovering`, or `stale` |
| `error:nonfatal` | Recoverable error; do not tear down view |
| `prefetch:state` | Optional dev feedback on prefetch queue |

**Media assets are never sent over Socket.IO.** They are always delivered as URLs.

**All Socket.IO event payloads must be typed in `packages/shared-types`.** Never use anonymous JSON blobs.

### Reconnect Behavior

On reconnect:
1. Client reconnects via Socket.IO
2. Client re-emits `viewport:subscribe` with current state
3. Server rebuilds subscription
4. Server emits `viewport:subscribed` + current slot updates + playback state + freshness
5. Client must not assume session continuity

---

## Python Media Service API

### POST /frame/extract
```json
Request:  { "camera": "front_door", "timestamp": 1711382405.25, "mode": "fast", "format": "jpg", "width": 320 }
Response: { "ok": true, "cache_hit": true, "media_url": "/media/frame/front_door/1711382405.jpg",
            "source": "frigate_snapshot_api", "requested_timestamp": 1711382405.25, "resolved_timestamp": 1711382405.24 }
```

### POST /frame/extract_batch
```json
Request:  { "camera": "front_door", "timestamps": [1711382400, 1711382405], "mode": "fast" }
```

### POST /preview/strip
```json
Request:  { "camera": "front_door", "start_time": 1711382400, "end_time": 1711382460 }
Response: { "ok": true, "url": "/media/preview/front_door/1711382400_1711382460.webp" }
```

### POST /clip/prepare
```json
Request:  { "camera": "front_door", "start_time": 1711382400, "end_time": 1711382460 }
Response: { "ok": true, "clip_url": "/media/clip/front_door/clip_123.mp4", "status": "ready" }
```

### GET /health

Resolution strategy (Python side):
1. Check disk cache
2. Try Frigate snapshot HTTP endpoint
3. Fallback to FFmpeg extraction
4. Store result in cache, return URL

---

## Frigate Integration

### MQTT Topics (subscribe)
- `frigate/available` — Frigate availability state
- `frigate/events` — primary tracked-object lifecycle stream
- `frigate/tracked_object_update` — enrichment updates (face, LPR, classification)
- `frigate/reviews` — review item lifecycle
- `frigate/stats` — optional observability
- `frigate/camera_activity` — optional UX

### HTTP Endpoints (use for)
- `/events`, `/events/search` — historical backfill and cold start
- `/review` — review item hydration
- `/preview` — preview strip assistance (later)
- `/media`, `/snapshot` — media lookup (Python media-service)
- `/export` — deferred clip export feature

### Ingest Pipeline
```
MQTT message → normalize → SQLite upsert → update in-memory index → invalidate dirty slots
HTTP backfill → fetch events → normalize → SQLite upsert → update index → invalidate if needed
```

### Recovery on Reconnect
1. Detect disconnect gap
2. Query HTTP for missed time range
3. Merge missing entities into SQLite + memory
4. Resume MQTT

### Freshness States
- `live` — MQTT active and current
- `recovering` — reconnect/backfill in progress
- `stale` — MQTT unavailable

---

## SQLite Schema (TypeScript Core Only)

Python media-service does **not** write to SQLite.

Core tables:

**semantic_entities** — normalized Frigate object detections. Primary key: event id. Indexed on camera + time columns.

**entity_enrichments** — face, LPR, classification, description updates keyed by entity_id.

**review_items** — Frigate review lifecycle. Stored separately from semantic entities; linked by event ids.

**media_cache** — metadata for disk-cached frames. Key: (camera, timestamp, mode, format, size).

**ingest_state** — checkpoint tracking: last_event_time, last_backfill_time, last_mqtt_message_time per source+camera.

**schema_migrations** — versioned migration history. Apply on startup; never modify existing migrations.

### Data Flow
```
Startup:   open DB → run migrations → hydrate in-memory index → connect MQTT → start scheduler
Ingest:    MQTT → normalize → SQLite upsert → update memory → invalidate slots
Resolve:   query memory (not SQLite) → compute result → update slot cache
Recovery:  DB unavailable → degrade to memory-only; corruption → rebuild from Frigate HTTP
```

---

## SemanticIndex Structure

The in-memory index is the **primary read path for the resolver**. Do not query SQLite in the hot resolution path.

```
byId:         Map<EventId, SemanticEntity>        — direct lookup and merge
byCamera:     Map<CameraName, Set<EventId>>        — early candidate set restriction
byLabel:      Map<string, Set<EventId>>            — fast object label filter
byZone:       Map<string, Set<EventId>>            — fast zone filter
byTimeBucket: Map<bucketKey, Set<EventId>>         — coarse overlap pruning (fixed buckets)
```

Start with coarse time-bucket indexing. Do not build an interval tree unless profiling proves it necessary.

---

## Key TypeScript Types

```typescript
type EventId = string;
type CameraName = string;
type TimestampSec = number;

type PlaybackState = "LIVE_STREAM" | "SCRUBBING" | "SCRUB_REVIEW" | "PLAYBACK_RECORDING" | "FOLLOW_NOW_IDLE";
type SlotStatus = "clean" | "dirty" | "resolving";
type SemanticFreshness = "live" | "stale" | "recovering";
type ResolvedStrategy = "A" | "B";
```

The full `SemanticEntity`, `TypeBRequest`, `TypeBResult`, and all Socket.IO payload types live in `packages/shared-types`. Both frontend and core-server import from there.

---

## Object Types and Icons

| Object | Lucide Icon |
|---|---|
| person | user |
| face | scan-face |
| car | car |
| motorcycle | motorbike |
| bicycle | bike |
| licence_plate | gallery-vertical |
| amazon / fedex / ups / dhl | truck |
| usps | mail |
| dog | bone |
| cat / deer / raccoon / squirrel / rabbit | paw-print |
| package | package |
| bird | bird |

---

## Video Behavior

**Live Stream:** Served via go2rtc or MSE. Shown when tCursor = tNow. On user timeline interaction, switch to frame mode immediately.

**Recordings:** Always preloaded in background based on camera + time selection. When tCursor stops moving: display frame type as normal, but load and queue recording for tCursor time, play as soon as loaded, advance tCursor with playback. On user timeline interaction, return to frame mode (keep recording in cache).

**Target:** 15 FPS, 15-frame I-frame interval.

---

## Recommended Adapter Classes

TypeScript core: `FrigateHttpClient`, `FrigateMqttIngestor`, `FrigateEntityNormalizer`, `FrigateReviewNormalizer`, `FrigateRecoveryCoordinator`

Python media-service: `FrigateMediaClient`, `RecordingLocator`, `FfmpegFallbackService`

**Wrap all Frigate API calls behind these adapters.** Do not scatter direct Frigate HTTP/MQTT calls across the codebase. This keeps version-specific handling contained.

---

## Milestone Plan

| Milestone | Goal | Key Deliverables |
|---|---|---|
| **M0** | Skeleton + shared contracts | Monorepo, all services start, Socket.IO handshake, SQLite migrations, shared types compile |
| **M1** | Type A timeline end-to-end | 60-slot rendering, slot:resolved transport, scrub interaction, Python frame cache working |
| **M2** | Type B semantic hydration | HTTP backfill, SemanticIndex, TypeBResolver, per-slot B/A fallback, SQLite persistence |
| **M3** | MQTT freshness + dirty slots | MQTT ingest, range invalidation, slot:dirty events, reconnect recovery |
| **M4** | Playback + polish | Full playback state machine, preview/clip integration, debug overlay, performance tuning |

**Principle:** Build the baseline timeline first, then layer semantic intelligence on top. Keep Type A reliable before expanding Type B complexity.

---

## Repository Conventions

### Monorepo Structure

npm workspaces. Three workspace members:

```
apps/frontend          React + Vite + TypeScript (port 5173)
apps/core-server       Fastify + Socket.IO + TypeScript (port 4010)
apps/media-service     FastAPI + Python (port 4020)
packages/shared-types  Shared TypeScript contracts (package name: @frigate-review/shared-types)
```

`apps/media-service` is **not** in the npm workspace — it is a standalone Python project with its own virtualenv.

Build order matters: `shared-types` must build before `core-server` and `frontend`.

```bash
# Full build
npm run build
# which runs: shared-types → core-server → frontend

# Dev (run separately)
npm run dev:frontend    # apps/frontend
npm run dev:core        # apps/core-server
cd apps/media-service && uvicorn app.main:app --reload --port 4020
```

### TypeScript Config

All TypeScript packages extend `tsconfig.base.json` at the repo root:

```json
{
  "target": "ES2022",
  "module": "ESNext",
  "moduleResolution": "Bundler",
  "strict": true,
  "esModuleInterop": true,
  "forceConsistentCasingInFileNames": true,
  "skipLibCheck": true,
  "resolveJsonModule": true
}
```

- `core-server` adds: `"outDir": "dist"`, `"baseUrl": "."`
- `shared-types` adds: `"outDir": "dist"`, `"declaration": true`, `"declarationMap": true`, `"sourceMap": true`
- `frontend` adds: `"jsx": "react-jsx"`, `"types": ["vite/client"]`

All packages use `"type": "module"` in their `package.json`.

### shared-types Package

Package name: `@frigate-review/shared-types`

Consumed by `frontend` and `core-server` as a local workspace dependency (`"@frigate-review/shared-types": "0.0.1"`).

**All Socket.IO payload interfaces live here.** Currently exported from `packages/shared-types/src/index.ts`:

- `PlaybackState`, `SlotStatus`, `SemanticFreshness`
- `FilterState`, `ClientViewportState`
- `ViewportSubscribeEvent`, `ViewportSubscribedEvent`, `ViewportUpdateEvent`
- `SlotResolvedEvent`, `SlotDirtyEvent`, `PlaybackStateEvent`
- `TimelineViewport`, `TimelineSlot`

When adding new event types, add them here first, build shared-types, then consume in core-server and frontend. Never define payload types inline in either app.

### core-server

- Framework: **Fastify v5** + **Socket.IO v4**
- Dev runner: `tsx watch src/server.ts`
- Entry point: `src/server.ts` (to be created)

### frontend

- Framework: **React 18** + **Vite 5**
- Socket.IO client: `socket.io-client` v4
- Core connects to `http://localhost:4010`
- Entry: `src/main.tsx` → mounts to `<div id="root">`
- No CSS framework is committed yet — do not introduce one without discussion

### media-service

- Framework: **FastAPI 0.115** + **uvicorn 0.30** + **pydantic v2**
- Python virtualenv at `apps/media-service/.venv`
- App entry: `app/main.py` (module path `app.main:app`)
- Internal package structure:
  ```
  app/
    main.py          FastAPI app + router registration
    api/
      frame.py       /frame/extract and /frame/extract_batch routes
    services/
      frame_service.py  FrameService class
    models/
      frame.py       Pydantic models: FrameExtractRequest, FrameExtractResponse, BatchFrameExtractRequest
  ```
- `FrameService.extract_frame()` is currently a placeholder. Real implementation goes here.
- Pydantic v2 is in use — use `model_validator`, `field_validator`, and `model_config` (not v1 `validator`/`Config`)

### Naming Conventions

- TypeScript interfaces: PascalCase (`SemanticEntity`, `SlotResolvedEvent`)
- Socket.IO event names: `namespace:action` kebab-case (`viewport:subscribe`, `slot:resolved`)
- Python classes: PascalCase (`FrameService`, `RecordingLocator`)
- Python files: snake_case (`frame_service.py`, `recording_locator.py`)
- SQLite tables: snake_case (`semantic_entities`, `ingest_state`)

### M0 Startup Verification Checklist

After first install, verify:
1. `npm install` from repo root resolves all workspace deps
2. `npm run build` in `packages/shared-types` succeeds with no type errors
3. `npm run dev:core` starts Fastify on port 4010 and Socket.IO is reachable
4. `npm run dev:frontend` starts Vite on port 5173 and frontend loads
5. Frontend connects to core-server: Socket.IO status shows "connected"
6. Frontend emits `viewport:subscribe` and receives `viewport:subscribed`
7. Python media-service starts: `GET /health` returns `{"ok": true, "service": "media-service"}`
8. SQLite migrations apply on core-server startup without errors

---

## Development Rules

1. **Shared types go in `packages/shared-types`.** Frontend and core-server must not define duplicate interfaces.
2. **SQLite is internal to core-server.** Python media-service never writes to it.
3. **No synchronous per-slot HTTP queries in the hot path.** Use in-memory index for resolution; HTTP is for backfill and recovery only.
4. **MQTT is not treated as complete source of truth.** It can be lossy. HTTP provides authoritative history.
5. **All slot boundaries are computed server-side.** Frontend sends viewport parameters only.
6. **Frontend never infers resolution strategy.** Server decides A vs B and communicates it in `resolvedStrategy`.
7. **Never block the UI on slot resolution.** Slots update incrementally; dirty slots resolve in-place.
8. **Slot cache keys are deterministic:** `camera + tSlotCenter + mode + resolution`
9. **Keep Frigate adapters centralized.** Version-specific payload changes stay inside the adapter layer.
10. **Last write wins for concurrent slot results.** Later results for the same `viewportId + slotIndex` supersede earlier ones.

---

## Failure Handling Summary

| Failure | Behavior |
|---|---|
| Type B resolution fails | Fall back to Type A |
| Repeated resolution failures | Throttle retries, degrade to Type A |
| MQTT unavailable | Mark `semantic:freshness = stale`; continue in HTTP-backed degraded mode |
| HTTP unavailable | Serve from local SQLite + in-memory state |
| Recording/snapshot unavailable | Type A fallback within policy; emit `error:nonfatal` |
| SQLite unavailable | Degrade to memory-only mode |
| SQLite corruption | Rebuild from Frigate HTTP backfill |
| Migration failure | Block startup |

---

## Open Items (as of M0)

- Pin and document tested Frigate version(s)
- Capture exact Frigate HTTP endpoints used once adapters are scaffolded
- Decide whether preview endpoints are integrated in M4 or later
- Decide whether clip export is TypeScript-initiated or Python-mediated
- Tune Type B scoring weights against real captured examples
- Define retention policy for debug trace data in SQLite
