# Claude Chrome Testing Prompt

Paste the block below into Claude with browser access. It gives Claude full context to drive the test run autonomously across both the local network and the public nginx URL.

---

## Prompt (copy everything below this line)

---

You are testing **Frigate Review Accelerator** — a real-time surveillance footage review app built on Frigate NVR.

Before testing, read the source code at:
**https://github.com/helicopterrun/frigate-review-accelerator**

Focus on: `apps/frontend/src/`, `apps/core-server/src/`, `apps/media-service/app/`, and `TESTING.md` in the repo root. Understanding the code will help you identify root causes rather than just surface symptoms.

---

### Two environments to test

| Environment | URL | Notes |
|---|---|---|
| **Local (LAN)** | `http://192.168.50.207:5173/` | Direct Vite dev server. No nginx. Use this to isolate frontend-only issues. |
| **Public (nginx)** | `https://frigatebird.pondhouse.cloud/` | Proxied through nginx proxy manager. Tests HTTPS, Socket.IO proxy, and media proxy. |

Test **both** environments. Many failures in the public URL that pass on local indicate a proxy configuration issue, not a code bug.

---

### Infrastructure reference

| Service | Local address | Expected nginx proxy path |
|---|---|---|
| Frontend (Vite) | `http://192.168.50.207:5173` | `/` (catch-all) |
| Core server (Socket.IO) | `http://192.168.50.207:4010` | `/socket.io/` → `localhost:4010` |
| Media service (FastAPI) | `http://192.168.50.207:4020` | `/api-media/` → `localhost:4020` |
| Frigate NVR | `http://192.168.50.207:5000` | `/frigate/` → `localhost:5000` |

---

### App overview

The app has three panels:
- **Left** — a vertical timeline wheel (Pixi.js canvas). 60 slots, each representing a time bucket. Center row = cursor position.
- **Right** — video/preview panel: live JPEG feed, still frame preview, or HLS recording playback
- **Header** — camera selector, socket status badge (`connected`/`disconnected`/`error`), freshness badge (`live`/`recovering`/`stale`), playback state badge, slot count (e.g. `60/60 · 8B 52A`), Debug button

Key terms:
- **Slot** — one time bucket. Strategy **A** = FFmpeg-extracted frame. Strategy **B** = Frigate event snapshot (semantic best candidate, only used when zoom ≥ 5 min)
- **Freshness** — MQTT health: `live` / `recovering` / `stale`
- **Slot grid** — thumbnail grid below the video panel (always visible)
- **Debug overlay** — detailed state table, toggled with the Debug button

---

### Instructions

For each numbered test:
1. Perform the action on **both** environments unless marked LOCAL or PUBLIC only
2. Record: environment, PASS / FAIL / SKIP, and a one-line note
3. On failure, capture the exact console error or visual symptom
4. Do not stop on failures — complete every item

---

## Part 1 — Setup

Run on both environments.

**1.** Navigate to each URL. Confirm the app renders (timeline canvas visible, header present, not a blank page or error screen).

**2.** Open DevTools console. Record any red errors present immediately on load.

**3.** Confirm the socket status badge reads **connected** within 3 seconds.
- If FAIL on public but PASS on local → nginx `/socket.io/` proxy is missing or missing WebSocket upgrade headers.

**4.** Confirm the freshness badge reads **live** within 5 seconds.
- If it stays on `recovering` → MQTT is connected but no Frigate events have arrived, or socket never connected.

**5.** Note the slot count in the header.

---

## Part 2 — Timeline & Frame Extraction (M1)

**6.** Measure time from page load to first slots appearing in the slot grid. Target: under 1.5 seconds.

**7.** Measure time for all 60 slots to fill. Target: under 6 seconds.

**8.** Confirm slots filled center-out — middle thumbnails appeared before edge thumbnails. (Watch carefully or reload and observe.)

**9.** Confirm header reaches **60/60** within the time measured in step 7.

**10.** Confirm no slots are solid white or solid grey — every slot should have either a real camera frame or a coloured mock placeholder (the mock frames have a camera name and timestamp drawn on them).

**11.** Click the **+** zoom button once. Confirm the time range label narrows. Confirm already-loaded slots return instantly (cache hit — no delay).

**12.** Keep clicking **+** to reach the tightest zoom stop. Confirm the header shows **0B** (all slots Type A at tight zoom).

**13.** Click **−** to zoom past 5 minutes total range. Confirm the header shows a non-zero B count (e.g. `8B`) — these are Frigate event snapshots chosen by the semantic resolver.
- If B count stays 0 even at wide zoom → backfill from Frigate returned no events, or MQTT index is empty. Check Frigate is running.

**14.** Use the mouse wheel over the timeline canvas. Confirm the cursor steps by one slot per scroll threshold (not continuous smooth scroll).

**15.** Confirm a **"Scrubbing..."** label appears in the playback controls immediately after scrolling, then disappears within ~1 second.

**16.** Click a row in the timeline canvas. Confirm the cursor jumps to that slot's timestamp (visible in the debug table Cursor row, or in the time readout).

**17.** On load, confirm the video panel shows a live JPEG image with a **LIVE** badge. (Requires Frigate port 5000 to be reachable — may fail on public if `/frigate/` is not proxied.)

**18.** Scroll the timeline away from NOW. Confirm the LIVE badge disappears and a still preview frame takes its place.

**19.** Wait 5 seconds without touching anything. Confirm the live feed resumes automatically.

---

## Part 3 — Type B Semantic Hydration (M2)

**20.** With zoom ≥ 5 minutes, look at the slot grid. Confirm some thumbnails have a **B** label or coloured indicator distinguishing them from A slots.

**21.** In the timeline wheel (left panel), confirm B slots show a small icon (person, car, dog, etc.) to the right of the time label with a coloured dot beside it.

**22.** Open **Debug**. In the Slot Detail table, confirm B rows show a numeric score (e.g. `42%`) not a dash.

**23.** Restart the core server on the host machine, then reload the page. Confirm B slots still appear within the first batch (not after a delay) — this proves startup hydration from SQLite is working.

---

## Part 4 — MQTT Freshness (M3)

**24.** With the app loaded, confirm the freshness badge shows **live**.

**25.** Walk in front of a camera. Within ~5 seconds, confirm one or more slots in the slot grid briefly show a **dirty** status indicator (yellow border or status text), then update to a new frame.
- If no dirty slots appear → MQTT events are not reaching the server, or the event's timestamp falls outside the current viewport.

---

## Part 5 — Playback (M4)

**26.** Scroll to a time slot that has a recording (a non-placeholder frame image). Click that row to move the cursor there.

**27.** Click **Play Recording**. Confirm the video panel switches from the still image to a playing video.

**28.** Watch the console for HLS errors. Confirm none appear.

**29.** Watch the cursor for 10 seconds. Confirm it **advances** as the video plays — the center row of the timeline wheel should move toward PRESENT over time.

**30.** Confirm the time readout in the playback controls updates while playing.

**31.** Click **Pause**. Confirm the video freezes and the cursor stops moving. Confirm the playback badge reads **SCRUB REVIEW**.

**32.** Click **Play Recording** again. Confirm the video resumes from where it paused (cursor does not jump back to the original start time).

**33.** Scroll to a different timestamp, then click **Play Recording**. Confirm the video starts from the new position.

---

## Part 6 — Debug Overlay

**34.** Click **Debug**. Confirm the overlay table shows all of these rows: Camera, Socket, Freshness, Playback, Scrubbing, Cursor, Range, Viewport, Slots, Playing, VOD URL, Preview.

**35.** Scroll the timeline with Debug open. Confirm the Cursor and Viewport rows update in real time.

**36.** Confirm the Slot Detail table (below the main table) shows columns: `#`, `Strategy`, `Score`, `Entity`, `Status`.

**37.** Confirm B-strategy rows are visually distinct from A rows (different colour or highlight).

---

## Part 7 — Camera switching

**38.** Change the camera using the header selector. Confirm the slot grid clears and reloads with new thumbnails.

**39.** Confirm the live feed switches to the new camera.

**40.** Confirm **Play Recording** works on the new camera.

---

## Part 8 — Edge cases

**41.** Select the last camera in the list (likely low activity). Confirm no crash. Placeholder frames acceptable.

**42.** Scroll the timeline several hours into the past. Confirm no crash and no JS errors.

**43.** Rapidly click **+** and **−** 10 times in quick succession. Confirm no crash and no duplicate or mismatched slot batches once it settles.

**44.** Refresh the page while a recording is playing. Confirm the app reloads cleanly into SCRUB_REVIEW state (not stuck in playing mode).

---

## Part 9 — API checks (run in DevTools console)

Run these on the **public URL** (`https://frigatebird.pondhouse.cloud`) unless otherwise noted.
If a check fails on public but passes on local (`http://192.168.50.207:4020`), the issue is the nginx proxy rule, not the service itself.

**45.** Core server health — run in console:
```javascript
fetch('https://frigatebird.pondhouse.cloud/health')
  .then(r => r.json()).then(console.log).catch(console.error)
```
Expect: `{"ok": true, "service": "core-server", ...}`

**46.** Media service health:
```javascript
fetch('https://frigatebird.pondhouse.cloud/api-media/health')
  .then(r => r.json()).then(console.log).catch(console.error)
```
Expect: `{"ok": true, "service": "media-service", "frigate_reachable": true}`
- If returns HTML → nginx `/api-media/` proxy rule is missing
- If `frigate_reachable: false` → Frigate on port 5000 is down

**47.** Media service health — local direct (run this too, to isolate nginx vs service):
```javascript
fetch('http://192.168.50.207:4020/health')
  .then(r => r.json()).then(console.log).catch(console.error)
```
Expect same as above. If this fails but the service is supposed to be running, the media service process itself is down.

**48.** Preview strip:
```javascript
fetch('https://frigatebird.pondhouse.cloud/api-media/preview/strip', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    camera: 'street-doorbell',
    start_time: Math.floor(Date.now()/1000) - 300,
    end_time: Math.floor(Date.now()/1000) - 60,
    count: 12
  })
}).then(r => r.json()).then(d => { console.log(d); if(d.url) window.open('https://frigatebird.pondhouse.cloud' + d.url) })
  .catch(console.error)
```
Expect: `{"ok": true, "url": "/media/preview/...webp", ...}`. A new tab should open showing a wide filmstrip image.

**49.** Clip prepare:
```javascript
fetch('https://frigatebird.pondhouse.cloud/api-media/clip/prepare', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    camera: 'street-doorbell',
    start_time: Math.floor(Date.now()/1000) - 300,
    end_time: Math.floor(Date.now()/1000) - 240
  })
}).then(r => r.json()).then(d => { console.log(d); if(d.clip_url) window.open('https://frigatebird.pondhouse.cloud' + d.clip_url) })
  .catch(console.error)
```
Expect: `{"ok": true, "clip_url": "/media/clips/...mp4", "status": "ready", ...}`. A new tab should open and the MP4 should play.

---

## Part 10 — Environment comparison summary

After completing all checks on both environments, fill in this comparison table:

| Check | Local (192.168.50.207:5173) | Public (frigatebird.pondhouse.cloud) |
|---|---|---|
| App loads | | |
| Socket connects | | |
| Freshness: live | | |
| Slots load (60/60) | | |
| Type B slots appear | | |
| Live JPEG feed | | |
| HLS playback | | |
| Cursor advances | | |
| Media service health | | |
| Preview strip API | | |
| Clip prepare API | | |

Any item that is PASS locally but FAIL publicly points to a missing nginx proxy rule. Reference the infrastructure table at the top to identify which rule is needed.

---

## Final report format

Produce:
1. The full numbered results table (both environments per item where tested)
2. The environment comparison table above, filled in
3. A diagnosis section: for each FAIL, one sentence on the root cause (code bug vs proxy config vs service down)
4. A prioritised fix list — highest impact first
