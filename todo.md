# Frigate Review Accelerator — TODO

## Completed

### M0 — Skeleton
- [x] Monorepo with npm workspaces (core-server, frontend, media-service, shared-types)
- [x] Socket.IO handshake (viewport:subscribe / viewport:subscribed)
- [x] SQLite migrations on startup
- [x] Shared types compiling and consumed by both apps

### M1 — Type A Timeline
- [x] 60-slot deterministic timeline model
- [x] slot:resolved / slots:batch_resolved transport
- [x] Python media-service FFmpeg frame extraction from Frigate recordings
- [x] Batch frame extraction (2-minute clip segments, single FFmpeg pass per segment)
- [x] Pixi.js timeline canvas with center-row priority and Lucide detection icons
- [x] Slot-step scrolling (replaced continuous scrub)
- [x] Live view mode (go2rtc stream when tCursor = tNow)
- [x] Loading state + auto-preview on slot hover
- [x] Progressive slot rendering — center-out chunked emission (15 slots/batch, ~1.4s first paint)
- [x] Zoom re-resolve: cached slots return immediately, new slots fill progressively
- [x] Zero console errors on load and interaction

---

## Up Next

### M2 — Type B Semantic Hydration
- [x] HTTP backfill from Frigate `/events` on viewport:subscribe
- [x] SemanticIndex populated from Frigate event history
- [x] TypeBResolver: score candidates by snapshot quality, area, zone match, label, motion
- [x] Per-slot B/A fallback: use Type B when tWheel >= 5 min, fall back to Type A
- [x] SQLite persistence for semantic_entities via entity-store.ts (upsertEntitiesBatch, upsertEntityToDb)
- [x] Dirty slot invalidation when new entity overlaps slot range
- [x] `slot:dirty` / `slots:dirty` events emitted to frontend
- [x] Startup hydration: index populated from SQLite on boot (Type B ready from first subscribe)
- [x] Ingest state tracking: last_event_time, last_backfill_time, last_mqtt_message_time per camera
- [x] MQTT reconnect gap-fill: back-fills missed events using ingest_state window + 60s buffer

### M3 — MQTT Freshness + Dirty Slots
- [x] MQTT ingest: frigate/events, frigate/tracked_object_update, frigate/reviews
- [x] Normalize MQTT payloads → SemanticIndex upsert (extractEnrichments, applyEnrichmentUpdate)
- [x] Range-based dirty slot invalidation on MQTT event (invalidateRangeForAllSessions)
- [x] semantic:freshness events (live / recovering / stale) — including silence-based staleness timer
- [x] Reconnect recovery: gap-fill using ingest_state window + 60s buffer
- [x] ingest_state checkpoint tracking in SQLite per source+camera
- [x] enrichments_json persisted and hydrated (migration 3)

### M4 — Playback + Polish
- [x] Full playback state machine (5 states, nextPlaybackState defined)
- [x] tCursor auto-advance in PLAYBACK_RECORDING mode (onVideoTimeUpdate via video.timeupdate)
- [x] Preview strip endpoint (POST /preview/strip — N-frame horizontal WebP filmstrip)
- [x] Clip export endpoint (POST /clip/prepare — local concat + Frigate HTTP fallback)
- [x] Debug overlay (slot index, strategy A/B, score, cache hit, entity ID)
- [x] prefetch:state dev feedback event (emitted after resolveAndEmitBatch completes)
- [x] Performance tuning — scheduler priority (VISIBLE > DIRTY > PREFETCH_FORWARD > PREFETCH_BACKWARD)

---

## Bug Fixes Applied
- [x] SemanticIndex: long-running entities missed by time-bucket lookup (only startTime was indexed; now indexes all buckets from start to end)
- [x] SemanticIndex: `overlaps()` used `>=` instead of `>` — entities ending exactly at a slot boundary were incorrectly included
- [x] FrigateRawEvent: missing `entered_zones` field; `enteredZones` always mirrored `currentZones`, losing cumulative zone history
- [x] entity-store: `??` doesn't guard against empty string in JSON.parse; changed to `||`
- [x] ffmpeg_extractor: HTTP fallback clip filename used `:.0f` (rounds to integer), causing filename collision and potential file corruption for concurrent nearby timestamps

---

## Known Issues / Deferred
- Type B scoring weights are placeholder — need tuning against real Frigate data
- Pin and document tested Frigate version(s)
- Retention policy for debug trace data in SQLite not yet decided
- Clip export: decide whether TypeScript-initiated or Python-mediated
