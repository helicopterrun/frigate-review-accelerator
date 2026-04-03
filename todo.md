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
- [ ] HTTP backfill from Frigate `/events` on startup and reconnect
- [ ] SemanticIndex populated from Frigate event history
- [ ] TypeBResolver: score candidates by snapshot quality, area, zone match, label, motion
- [ ] Per-slot B/A fallback: use Type B when tWheel >= 5 min, fall back to Type A
- [ ] SQLite persistence for semantic_entities, entity_enrichments, review_items
- [ ] Dirty slot invalidation when new entity overlaps slot range
- [ ] `slot:dirty` / `slots:dirty` events emitted to frontend

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
