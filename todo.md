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
- [ ] MQTT ingest: frigate/events, frigate/tracked_object_update, frigate/reviews
- [ ] Normalize MQTT payloads → SemanticIndex upsert
- [ ] Range-based dirty slot invalidation on MQTT event
- [ ] semantic:freshness events (live / recovering / stale)
- [ ] Reconnect recovery: detect gap, HTTP backfill missed range, resume MQTT
- [ ] ingest_state checkpoint tracking in SQLite

### M4 — Playback + Polish
- [ ] Full playback state machine (LIVE_STREAM, SCRUBBING, SCRUB_REVIEW, PLAYBACK_RECORDING, FOLLOW_NOW_IDLE)
- [ ] tCursor auto-advance in PLAYBACK_RECORDING mode
- [ ] Preview strip integration (/preview/strip endpoint)
- [ ] Clip export flow (/clip/prepare endpoint)
- [ ] Debug overlay (slot index, strategy A/B, score, cache hit)
- [ ] prefetch:state dev feedback event
- [ ] Performance tuning — scheduler priority (VISIBLE > DIRTY > PREFETCH_FORWARD > PREFETCH_BACKWARD)

---

## Known Issues / Deferred
- Type B scoring weights are placeholder — need tuning against real Frigate data
- Pin and document tested Frigate version(s)
- Retention policy for debug trace data in SQLite not yet decided
- Clip export: decide whether TypeScript-initiated or Python-mediated
