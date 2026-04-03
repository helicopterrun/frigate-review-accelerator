# Testing Checklist — Frigate Review Accelerator

Run through this from both your Mac (browser) and phone (mobile browser).
Mark each item pass / fail / skip. Note anything unexpected in the comments column.

---

## Setup (do this first on each device)

- [ ] Open the app in a browser
- [ ] Open browser dev tools (Mac: F12 / Cmd+Opt+I, Phone: use Safari Remote Debug or eruda)
- [ ] Confirm no red errors in the console on load
- [ ] Confirm the Socket.IO status badge shows **connected**
- [ ] Confirm the freshness badge shows **live** within ~5 seconds

---

## M1 — Timeline & Frame Extraction

### Initial load
- [ ] First batch of ~15 slots appears within ~1.5 seconds of page load
- [ ] All 60 slots fill in within ~6 seconds total
- [ ] Slots fill center-out (middle rows appear first, edges last)
- [ ] Slot count in header reads **60/60** when complete
- [ ] No blank white/grey frames — every slot has either an image or a mock placeholder

### Zoom
- [ ] Click **+** zoom button — range narrows, slots re-resolve
- [ ] Cached slots return **immediately** (no spinner); new slots fill progressively
- [ ] Click **−** zoom button — range widens back
- [ ] Zoom in all the way to the tightest stop — all slots should be Type A (no B badges in header)
- [ ] Zoom out past 5 minutes — header should start showing B count > 0 (if Frigate has events)

### Scroll / scrub
- [ ] Mouse wheel on timeline — cursor steps by one slot per threshold
- [ ] Touch swipe on timeline (phone) — cursor steps up/down
- [ ] "Scrubbing..." label appears briefly after each scroll, then disappears
- [ ] Tapping a row on the timeline seeks the cursor to that slot

### Live mode
- [ ] On load the video panel shows a live JPEG feed (polling latest.jpg)
- [ ] A **LIVE** badge appears over the live image
- [ ] Scroll timeline away from NOW — live feed stops, preview image appears
- [ ] Wait 5 seconds without interaction — live feed resumes automatically

---

## M2 — Type B Semantic Hydration

- [ ] At zoom ≥ 5 minutes, at least some slots show strategy **B** in the slot grid
- [ ] B slots have a Lucide icon (person / car / dog etc.) in the timeline wheel rows
- [ ] B slots show a confidence dot next to the icon
- [ ] Click Debug → "Slot Detail" table — B slots show a non-zero score (e.g. 42%)
- [ ] Header slot count shows e.g. **60/60 · 8B 52A** (numbers will vary)
- [ ] Restart core-server, reload page — B slots still appear immediately (hydrated from SQLite, no waiting for backfill)

---

## M3 — MQTT Freshness & Dirty Slots

- [ ] Freshness badge shows **live** when Frigate is running
- [ ] Stop the MQTT broker (or disconnect network briefly) — badge changes to **stale** within ~75 seconds
- [ ] Reconnect — badge returns to **live**, and slots from the gap period re-resolve
- [ ] Trigger a Frigate detection event (walk in front of a camera) — affected slots briefly show **dirty** status in the slot grid, then update to the new frame

---

## M4 — Playback

### Play recording
- [ ] Seek to a time that has recordings (not live)
- [ ] Click **Play Recording** button
- [ ] Video player switches to HLS video (not the live JPEG)
- [ ] Video plays without error
- [ ] The timeline cursor **advances** as the video plays (cursor moves down toward PRESENT)
- [ ] The time readout in the playback controls updates with the cursor

### Pause
- [ ] Click **Pause** — video pauses
- [ ] Timeline cursor stops advancing
- [ ] Playback state badge changes to **SCRUB REVIEW**

### Resume after pause
- [ ] Click **Play Recording** again — video resumes from paused position (cursor does not jump back to original start)

### Play from different positions
- [ ] Scroll to a different slot, click Play — video starts from that timestamp
- [ ] Cursor advance works correctly from the new start position

---

## Media Service Endpoints (test from Mac using curl or a REST client)

Replace `{HOST}` with your server's IP/hostname and adjust timestamps to times with recordings.

### Health
```
GET http://{HOST}:4020/health
```
- [ ] Returns `{"ok": true, "service": "media-service", "frigate_reachable": true}`

### Single frame
```
POST http://{HOST}:4020/frame/extract
{"camera": "street-doorbell", "timestamp": <unix_ts>, "mode": "fast", "width": 320}
```
- [ ] Returns `{"ok": true, "media_url": "/media/..."}` 
- [ ] `http://{HOST}:4020{media_url}` loads a JPEG image

### Preview strip
```
POST http://{HOST}:4020/preview/strip
{"camera": "street-doorbell", "start_time": <ts>, "end_time": <ts+120>, "count": 12}
```
- [ ] Returns `{"ok": true, "url": "/media/preview/..."}`
- [ ] URL loads a wide WebP image (12 frames side-by-side)
- [ ] Second identical request is instant (cache hit)

### Clip prepare
```
POST http://{HOST}:4020/clip/prepare
{"camera": "street-doorbell", "start_time": <ts>, "end_time": <ts+60>}
```
- [ ] Returns `{"ok": true, "clip_url": "/media/clips/...", "status": "ready"}`
- [ ] `http://{HOST}:4020{clip_url}` downloads/plays a valid MP4
- [ ] Second identical request is instant (cache hit)

---

## Debug Overlay (Mac only — too small on phone)

- [ ] Click **Debug** button — overlay appears
- [ ] Table shows: Camera, Socket, Freshness, Playback state, Cursor timestamp, Range, Viewport, Slots count, Playing, VOD URL, Preview URL
- [ ] "Slot Detail (first 10)" table shows slot index, strategy (A/B), score, entity ID, status
- [ ] B-strategy rows are highlighted differently from A rows
- [ ] Values update live as you scroll the timeline

---

## Mobile-specific (phone only)

- [ ] Header collapses — hamburger menu (☰) button is visible
- [ ] Tap hamburger — drawer slides open with camera selector, status badges, debug toggle
- [ ] Tap backdrop — drawer closes
- [ ] Camera selector works inside the drawer
- [ ] Touch scrubbing on the timeline wheel is responsive (no stuck/lagging feel)
- [ ] Timeline canvas fills the left panel without overflowing

---

## Camera switching

- [ ] Change camera in the selector — slots clear and reload for the new camera
- [ ] Live view switches to the new camera
- [ ] Debug overlay shows updated camera name
- [ ] Play Recording works on the new camera

---

## Edge cases

- [ ] Select a camera with no recent recordings — slots show mock/placeholder frames, no crash
- [ ] Scroll far into the past (hours ago) — timeline resolves without error
- [ ] Rapidly click + and − zoom buttons many times — no crash, no duplicate slot batches
- [ ] Refresh the page mid-playback — app reloads cleanly into SCRUB_REVIEW state
