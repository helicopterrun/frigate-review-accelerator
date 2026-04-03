# Claude Chrome Testing Prompt

Paste the block below into Claude with browser/computer access (e.g. Claude.ai with a screen-sharing or browser-use tool active). It gives Claude enough context to drive the full test run autonomously.

---

## Prompt (copy everything below this line)

---

You are testing **Frigate Review Accelerator** — a real-time surveillance footage review app built on Frigate NVR. The app is running at `https://frigatebird.pondhouse.cloud`.

Your job is to work through the test checklist below systematically. For each item:
1. Perform the action or observation described
2. Record PASS, FAIL, or SKIP with a one-line note
3. If something fails, capture the exact error text or unexpected behaviour before moving on
4. At the end, produce a summary table of all results

Do not stop on failures — continue through all items and report everything at the end.

---

### App overview (read before testing)

The app has three panels:
- **Left** — a vertical timeline wheel (Pixi.js canvas). Slots represent time buckets. The center row is the current cursor position.
- **Right** — a video/preview panel showing either a live JPEG feed, a still frame preview, or an HLS recording playback
- **Header** — camera selector, socket status badge, freshness badge, playback state badge, slot count (e.g. `60/60 · 8B 52A`), and a Debug button

Key terms:
- **Slot** — one time bucket in the 60-slot timeline. Strategy A = FFmpeg frame, Strategy B = Frigate event snapshot (semantic best candidate)
- **Freshness** — MQTT connection state: `live` / `recovering` / `stale`
- **tWheel** — total visible time span. Below 5 minutes = Type A only. Above 5 minutes = Type B preferred
- **Slot grid** — the grid of thumbnail images below the video panel (visible without Debug)
- **Debug overlay** — detailed table, toggled with the Debug button

---

### Setup checks (do these first)

1. Navigate to `https://frigatebird.pondhouse.cloud`
2. Open the browser console (DevTools → Console tab)
3. Check: no red errors on load
4. Check: socket status badge in header says **connected**
5. Check: freshness badge says **live** within 5 seconds of load
6. Note the current slot count displayed in the header

---

### M1 — Timeline & Frame Extraction

**Initial load**
7. Note the time from page load to first slots appearing in the slot grid (target: under 1.5s)
8. Note the time for all 60 slots to fill (target: under 6s)
9. Confirm slots filled center-out — middle thumbnails appeared before edge thumbnails
10. Confirm header reads **60/60** when complete
11. Confirm no solid white or solid grey frames in the slot grid (every slot should have a real image or a colored mock placeholder)

**Zoom**
12. Click the **+** zoom button once — confirm the range label in the debug table narrows and slots re-resolve
13. Click **+** several more times to reach the tightest zoom — confirm the header shows **0B** (all Type A)
14. Click **−** to zoom out past 5 minutes — confirm header shows **B count > 0** (Type B slots appear, assuming there are Frigate events in the current window)
15. Confirm cached slots return instantly on zoom (no re-extraction delay for already-loaded slots)

**Scroll**
16. Use the mouse wheel over the timeline canvas — confirm the cursor row steps by one slot per scroll threshold
17. Confirm a "Scrubbing..." label briefly appears in the playback controls after scrolling, then disappears within ~400ms
18. Click a row in the timeline canvas — confirm the cursor jumps to that slot's time

**Live mode**
19. On load, confirm the video panel shows a live JPEG image with a **LIVE** badge
20. Scroll the timeline away from the current time — confirm the live feed stops and a preview frame appears
21. Wait 5 seconds without interacting — confirm the live feed resumes automatically

---

### M2 — Type B Semantic Hydration

22. With zoom ≥ 5 minutes, check the slot grid — confirm some thumbnails have a coloured top border or "B" label indicating Type B strategy
23. In the timeline wheel, confirm B slots show a small Lucide icon (person, car, dog, etc.) to the right of the time label, with a coloured dot
24. Click **Debug** → look at the Slot Detail table → confirm B rows show a score value (e.g. `42%`), not `-`
25. Check the header slot count — it should read something like `60/60 · 8B 52A` (exact numbers will vary by time of day and camera activity)

---

### M4 — Playback

26. Scroll the timeline back in time to a slot that has a recording (non-live time, should show a frame image not a placeholder)
27. Click **Play Recording**
28. Confirm the video panel switches from the still preview image to a playing video (HLS stream)
29. Confirm the video plays without buffering errors in the console
30. Watch the cursor for 5–10 seconds — confirm it **advances** as the video plays (the center row of the timeline wheel moves down toward PRESENT)
31. Confirm the time readout in the playback controls (bottom of video panel) updates as the cursor advances
32. Click **Pause** — confirm the video pauses and the cursor stops moving
33. Confirm the playback state badge changes to **SCRUB REVIEW** after pausing
34. Click **Play Recording** again — confirm video resumes and cursor continues advancing (does not jump back to original start time)
35. Scroll to a different slot position, click **Play Recording** again — confirm video starts from the new timestamp

---

### Debug overlay

36. Click **Debug** — confirm the overlay table appears with rows for: Camera, Socket, Freshness, Playback, Scrubbing, Cursor, Range, Viewport, Slots, Playing, VOD URL, Preview
37. Scroll the timeline while Debug is open — confirm the Cursor and Viewport rows update in real time
38. Confirm the Slot Detail table at the bottom shows columns: #, Strategy, Score, Entity, Status
39. Confirm B-strategy rows are visually distinct from A rows

---

### Camera switching

40. Change the camera using the selector in the header
41. Confirm the slot grid clears and reloads for the new camera (new thumbnails, not the same frames)
42. Confirm the live view in the video panel switches to the new camera feed
43. Confirm **Play Recording** works on the new camera

---

### Edge cases

44. Select a camera that is unlikely to have recent recordings (pick one from the bottom of the list)
45. Confirm the app does not crash — placeholder frames or mock images should appear, no JS errors
46. Scroll the timeline far into the past (several hours) — confirm the app loads without errors
47. Rapidly click **+** and **−** zoom buttons 10 times quickly — confirm no crash and no duplicate or mismatched slot batches when it settles

---

### Media service API checks (run these in the browser console via fetch)

Run each of these in the DevTools console. They test the Python media service directly.

**Health check:**
```javascript
fetch('https://frigatebird.pondhouse.cloud/api-media/health')
  .then(r => r.json()).then(console.log)
```
48. Confirm response includes `"ok": true` and `"frigate_reachable": true`

**Preview strip** (replace CAMERA and timestamps with real values):
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
}).then(r => r.json()).then(console.log)
```
49. Confirm response includes `"ok": true` and a `"url"` path ending in `.webp`
50. Open the returned URL in a new tab — confirm it loads a wide filmstrip image (12 frames side by side)

**Clip prepare:**
```javascript
fetch('https://frigatebird.pondhouse.cloud/api-media/clip/prepare', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    camera: 'street-doorbell',
    start_time: Math.floor(Date.now()/1000) - 300,
    end_time: Math.floor(Date.now()/1000) - 240
  })
}).then(r => r.json()).then(console.log)
```
51. Confirm response includes `"ok": true`, `"status": "ready"`, and a `"clip_url"` path ending in `.mp4`
52. Open the returned clip URL — confirm it plays as a video

---

### Final report

After completing all 52 checks, output a results table in this format:

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | No console errors on load | PASS | |
| 2 | Socket badge: connected | PASS | |
| ... | | | |

Then write a short paragraph summarising:
- Total PASS / FAIL / SKIP counts
- Any patterns in failures (e.g. all API checks failed → likely a proxy config issue)
- Recommended next steps for any failures

---

**Note on API paths:** The fetch URLs above assume nginx proxy manager is routing `/api-media/` to the Python media service on port 4020. If the proxy path differs on your setup, adjust accordingly. The core Socket.IO server is on port 4010 and the frontend on port 5173 — both proxied through nginx at the same domain.
