/**
 * App — Main application shell.
 *
 * v3 layout:
 *   - 100vh flex-column, no scroll
 *   - Single-camera: 2-column layout (VideoPlayer left, VerticalTimeline right)
 *   - Hover on VerticalTimeline shows preview overlay on VideoPlayer (hoverTs)
 *   - Click on VerticalTimeline commits playback (handleSeek)
 *   - "Go to" datetime input in controls bar (single-camera mode only)
 *   - SplitView path unchanged
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}
import CameraSelector from './components/CameraSelector.jsx';
import Timeline from './components/Timeline.jsx';
import VerticalTimeline from './components/VerticalTimeline.jsx';
import VideoPlayer from './components/VideoPlayer.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import SplitView from './components/SplitView.jsx';
import {
  fetchCameras,
  fetchDensity,
  fetchTimeline,
  fetchPreviewStrip,
  fetchPlaybackTarget,
  fetchSegmentInfo,
  fetchHealth,
  requestPreviews,
  eventSnapshotUrl,
} from './utils/api.js';
import { nowTs, formatDateTime, formatTime, bucketSizeForRange } from './utils/time.js';
import { RETICLE_FRACTION } from './utils/constants.js';

// Autoplay: idle threshold before timeline starts advancing.
const AUTOPLAY_DELAY_MS = 1500;

const MIN_RANGE_SEC = 15 * 60;
const MAX_RANGE_SEC = 7 * 24 * 3600;

const LABEL_COLORS = {
  person: '#4CAF50',
  car: '#2196F3',
  dog: '#FF9800',
  cat: '#9C27B0',
  default: '#607D8B',
};

/**
 * Snap a timestamp to the nearest covered position in a sorted segment array.
 *
 * If ts falls inside a segment: returned as-is (fine-grained scrub still works).
 * If ts falls in a gap: returns the nearest segment edge so the preview and
 * cursor always land on actual footage, regardless of zoom level.
 *
 * Binary search — O(log n) even across 1.5M segments.
 */
function snapToCoverage(ts, segments) {
  if (!segments?.length) return ts;
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (ts < seg.start_ts) hi = mid - 1;
    else if (ts > seg.end_ts) lo = mid + 1;
    else return ts; // inside a segment — no snap needed
  }
  // In a gap: lo = index of first segment after ts
  const prev = lo > 0 ? segments[lo - 1] : null;
  const next = lo < segments.length ? segments[lo] : null;
  if (!prev) return next.start_ts;
  if (!next) return prev.end_ts;
  return (ts - prev.end_ts) <= (next.start_ts - ts) ? prev.end_ts : next.start_ts;
}

/** Format a Unix timestamp for a datetime-local input value. */
function toDatetimeLocal(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// TODO: unit test — verify labelCounts updates when timelineData changes,
// and that count badges show 0 for labels with no events in range.
function LabelFilterPills({ availableLabels, activeLabels, onToggle, onToggleAll, labelCounts = {}, isMobile }) {
  if (!availableLabels?.length) return null;
  const allActive = activeLabels === null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
      <button
        onClick={onToggleAll}
        style={{
          padding: '5px 14px', borderRadius: 16,
          border: `${allActive ? '2px' : '1px'} solid ${allActive ? '#aaa' : '#2a2d37'}`,
          background: allActive ? '#2a2d37' : 'transparent',
          color: allActive ? '#e0e0e0' : '#555',
          fontSize: 13, fontWeight: allActive ? 600 : 400,
          cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
          transition: 'all 0.15s ease',
        }}
      >all</button>
      {availableLabels.map(label => {
        const color = LABEL_COLORS[label] ?? LABEL_COLORS.default;
        const isActive = activeLabels === null || activeLabels.has(label);
        const count = labelCounts[label] ?? 0;
        return (
          <button key={label} onClick={() => onToggle(label)} style={{
            padding: '5px 14px', borderRadius: 16,
            border: `${isActive ? '2px' : '1px'} solid ${isActive ? color : '#2a2d37'}`,
            background: isActive ? `${color}18` : 'transparent',
            color: isActive ? color : '#555',
            fontSize: 13, fontWeight: isActive ? 600 : 400,
            cursor: 'pointer', fontFamily: 'monospace',
            display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
            transition: 'all 0.15s ease',
          }}>
            {label}
            <span style={{ opacity: 0.6, marginLeft: 2, fontSize: 11 }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function App() {
  const isMobile = useIsMobile();
  const [opsOpen, setOpsOpen] = useState(false);
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [selectedCameras, setSelectedCameras] = useState([]);
  const [multiMode, setMultiMode] = useState(false);

  const [timelineData, setTimelineData] = useState(null);
  const [densityData, setDensityData] = useState(null);
  const [currentEventIndex, setCurrentEventIndex] = useState(null);
  // TODO: importantOnly and the Phase 1 label set must stay in sync with
  // settings.important_labels in backend/app/config.py. Consider fetching
  // the list from a /api/config endpoint in Phase 2 instead of hardcoding.
  const [importantOnly, setImportantOnly] = useState(false);
  const [previewFrames, setPreviewFrames] = useState([]);
  const [cursorTs, setCursorTs] = useState(() => nowTs());
  const [rangeSec, setRangeSec] = useState(8 * 3600);
  const [hoverTs, setHoverTs] = useState(null);
  const [playbackTarget, setPlaybackTarget] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // ── Derived range: reticle at RETICLE_FRACTION from top ────────────────────
  // cursorTs maps to the reticle position by construction:
  //   rangeStart = cursorTs - rangeSec * (1 - RETICLE_FRACTION)  [past below reticle]
  //   rangeEnd   = cursorTs + rangeSec * RETICLE_FRACTION         [future above reticle]
  // TODO: verify rangeEnd never exceeds nowTs() + 60, rangeStart = cursorTs - rangeSec * (1 - RETICLE_FRACTION)
  // TODO: during video playback, cursorTs updates at ~30Hz; each update drives a
  //   rangeStart/rangeEnd change that triggers the data-fetch useEffect — consider
  //   debouncing in a follow-up PR if this causes excessive backend requests
  // Defensive guard: cursorTs should never be null after init, but if a future
  // code path sets it to null the fallback prevents NaN from cascading into
  // API requests, the RAF autoplay loop, and event navigation.
  // TODO: add frontend test verifying rangeStart/rangeEnd never NaN on camera switch.
  const { rangeStart, rangeEnd } = useMemo(() => {
    const cursor = cursorTs ?? nowTs();
    const start = cursor - rangeSec * (1 - RETICLE_FRACTION);
    const end = Math.min(cursor + rangeSec * RETICLE_FRACTION, nowTs() + 60);
    return { rangeStart: start, rangeEnd: end };
  }, [cursorTs, rangeSec]);

  const [gotoValue, setGotoValue] = useState(() => toDatetimeLocal(nowTs()));

  // Keyboard navigation + Escape to close ops drawer
  // Shortcuts: ← / → = ±5s | Shift+← / → = ±30s | Cmd/Ctrl+← / → = ±5m
  // TODO: test with React Testing Library — verify arrow keys adjust cursorTs,
  //       skip when input focused, clamp at nowTs()
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setOpsOpen(false); return; }
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

      let delta;
      if (e.metaKey || e.ctrlKey) delta = 5 * 60;
      else if (e.shiftKey) delta = 30;
      else delta = 5;

      if (e.key === 'ArrowLeft') delta = -delta;
      e.preventDefault();

      lastInteractionRef.current = Date.now();
      autoplayActiveRef.current = false;
      setCursorTs(prev => Math.min(prev + delta, nowTs()));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Mobile header expand/collapse
  const [healthExpanded, setHealthExpanded] = useState(false);
  useEffect(() => {
    if (!healthExpanded) return;
    const t = setTimeout(() => setHealthExpanded(false), 4000);
    return () => clearTimeout(t);
  }, [healthExpanded]);

  // Autoplay toggle — persisted to localStorage, default enabled
  const [autoplayEnabled, setAutoplayEnabled] = useState(() => {
    try { return localStorage.getItem('frigate-autoplay-enabled') !== 'false'; } catch { return true; }
  });

  // Label filter state — persisted to localStorage, null means "all"
  const [activeLabels, setActiveLabels] = useState(() => {
    try {
      const stored = localStorage.getItem('frigate-active-labels');
      return stored ? new Set(JSON.parse(stored)) : null;
    } catch { return null; }
  });

  // Event snapshot state (from prev/next navigation)
  const [activeEventSnapshot, setActiveEventSnapshot] = useState(null);

  // Refs that track the latest cursorTs / playbackTarget without being deps
  // of handleSegmentAdvance — avoids recreating the callback (and therefore
  // VideoPlayer's onSegmentAdvance prop) on every timeupdate event.
  const cursorTsRef = useRef(null);
  const playbackTargetRef = useRef(null);
  useEffect(() => { cursorTsRef.current = cursorTs; }, [cursorTs]);
  useEffect(() => { playbackTargetRef.current = playbackTarget; }, [playbackTarget]);

  // ── Autoplay refs — all reads/writes in RAF loop; no state to avoid 60fps re-renders ──
  // TODO: verify RAF cleanup cancels animationFrame on unmount (no leak).
  const lastInteractionRef = useRef(Date.now());
  const autoplayActiveRef = useRef(false);
  const autoplayStartRef = useRef(Date.now());
  const autoplayEnabledRef = useRef(true);   // synced with autoplayEnabled state below
  const autoplayRafRef = useRef(null);
  // nearEventCacheRef: sorted filteredEvents + next upcoming event ahead of cursor.
  // Updated by useEffect on filteredEvents (infrequent); re-searched inside setCursorTs.
  // TODO: verify pullFactor never drops below 0.2 and cache invalidates on filteredEvents change.
  const nearEventCacheRef = useRef({ sorted: [], event: null });

  // Sync autoplayEnabledRef so the RAF loop (stable effect, no deps) can read it.
  useEffect(() => { autoplayEnabledRef.current = autoplayEnabled; }, [autoplayEnabled]);

  // Update near-event cache whenever filteredEvents changes.
  // filteredEvents is stable between fetches (~30s), so this runs infrequently.
  // (defined later — populated once filteredEvents is derived below)

  // ─── Autoplay RAF loop ──────────────────────────────────────────────────────
  // Invariant: no state in deps — reads refs only, advances via functional setCursorTs.
  // TODO: test that cancelAnimationFrame is called on unmount with no leaked frames.
  useEffect(() => {
    function tick() {
      const now = Date.now();
      const idleMs = now - lastInteractionRef.current;
      const threshold = autoplayEnabledRef.current ? AUTOPLAY_DELAY_MS : Infinity;

      if (idleMs >= threshold) {
        if (!autoplayActiveRef.current) {
          autoplayActiveRef.current = true;
          autoplayStartRef.current = now;
        }

        // Ease-in over 300ms: advance rate ramps 0→1x
        const easeMs = Math.min(now - autoplayStartRef.current, 300);
        const easeFactor = easeMs / 300;
        const baseAdvanceSec = (1 / 60) * easeFactor;

        setCursorTs(prev => {
          let advanceSec = baseAdvanceSec;

          // Magnetization: decelerate near upcoming events (never below 20% rate).
          // Cache miss: if cursor passed the cached event, find the next one.
          // TODO: verify pullFactor clamp — distSec→0 gives pullFactor=0.2, distSec≥10 gives 1.0.
          let nextEvent = nearEventCacheRef.current.event;
          if (nextEvent && nextEvent.start_ts <= prev) {
            // Cursor has passed the cached event — search forward in sorted list.
            nextEvent = nearEventCacheRef.current.sorted.find(e => e.start_ts > prev) ?? null;
            nearEventCacheRef.current = { ...nearEventCacheRef.current, event: nextEvent };
          }
          if (nextEvent) {
            const distSec = nextEvent.start_ts - prev;
            if (distSec > 0 && distSec < 10) {
              const pullFactor = 0.2 + 0.8 * (distSec / 10);
              advanceSec *= pullFactor;
            }
          }

          return Math.min(prev + advanceSec, nowTs());
        });
      } else {
        if (autoplayActiveRef.current) {
          autoplayActiveRef.current = false;
        }
      }

      autoplayRafRef.current = requestAnimationFrame(tick);
    }

    autoplayRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (autoplayRafRef.current) cancelAnimationFrame(autoplayRafRef.current);
    };
  }, []); // stable — all values read from refs

  // ─── Init: load cameras + health ───
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [cams, hp] = await Promise.all([fetchCameras(), fetchHealth()]);
        if (cancelled) return;

        setCameras(cams);
        setHealth(hp);
        // TODO: when a frontend test harness is introduced, add a test that
        // verifies the 30s health poll does NOT reset selectedCamera when one
        // is already active. See CLAUDE.md "Example prompt" for context.
        if (cams.length > 0) {
          setSelectedCamera(prev => prev ?? cams[0].name);
        }
        setError(null);
      } catch (err) {
        if (!cancelled) setError(`Backend unreachable: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    const interval = setInterval(init, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // ─── Load timeline + previews (single camera mode) ───
  useEffect(() => {
    if (!selectedCamera || multiMode) return;
    let cancelled = false;

    async function load() {
      try {
        // bucketSizeForRange selects zoom-appropriate resolution for PR3 density endpoint.
        // Keep in sync with TimeIndex.auto_resolution() in backend/app/services/time_index.py.
        const _bucketSize = bucketSizeForRange(rangeSec); // eslint-disable-line no-unused-vars
        const [tl, strip] = await Promise.all([
          fetchTimeline(selectedCamera, rangeStart, rangeEnd),
          fetchPreviewStrip(selectedCamera, rangeStart, rangeEnd, 300),
        ]);
        if (cancelled) return;

        setTimelineData(tl);
        setPreviewFrames(strip.frames || []);
        setError(null);

        requestPreviews(selectedCamera, rangeStart, rangeEnd).catch(() => {});
      } catch (err) {
        if (!cancelled) setError(`Timeline load failed: ${err.message}`);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [selectedCamera, rangeStart, rangeEnd, multiMode]);

  // ─── Debounced density fetch (pan-optimized) ───
  // Fires 100ms after range changes to coalesce rapid pan events.
  // The full timeline fetch above stays as the source of truth for
  // segments/gaps; this provides lightweight density updates during scrolling.
  // TODO: add frontend test verifying this fires at most once per 100ms burst.
  useEffect(() => {
    if (!selectedCamera || multiMode) return;
    const timer = setTimeout(async () => {
      try {
        const bucketSec = bucketSizeForRange(rangeSec);
        const density = await fetchDensity(selectedCamera, rangeStart, rangeEnd, bucketSec);
        setDensityData(density);
      } catch {
        // Density is best-effort — don't surface errors for pan-time fetches
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedCamera, rangeStart, rangeEnd, rangeSec, multiMode]);

  // ─── Derived label lists ───
  const availableLabels = useMemo(() => {
    if (!timelineData?.events?.length) return [];
    return [...new Set(timelineData.events.map(e => e.label))].sort();
  }, [timelineData]);

  // Count per label across all events in range (unfiltered) — used by pill badges.
  // TODO: unit test — verify counts update when timelineData changes and
  // that filter persistence survives a localStorage round-trip.
  const labelCounts = useMemo(() => {
    const counts = {};
    for (const evt of timelineData?.events ?? []) {
      counts[evt.label] = (counts[evt.label] || 0) + 1;
    }
    return counts;
  }, [timelineData]);

  const filteredEvents = useMemo(() => {
    if (!timelineData?.events) return [];
    if (activeLabels === null) return timelineData.events;
    return timelineData.events.filter(e => activeLabels.has(e.label));
  }, [timelineData, activeLabels]);

  // Phase 1 importance: label-based hardcoded set.
  // TODO: sync with settings.important_labels in backend/app/config.py.
  // Phase 2 will fetch this list from a shared config endpoint.
  // TODO: unit test — verify importantOnly correctly filters navEvents list
  // and that currentEventIndex stays in bounds after filteredEvents changes.
  const IMPORTANT_LABELS = useMemo(() => new Set(['cat', 'bird', 'bear', 'horse']), []);
  const navEvents = useMemo(() => {
    const sorted = [...filteredEvents].sort((a, b) => a.start_ts - b.start_ts);
    return importantOnly ? sorted.filter(e => IMPORTANT_LABELS.has(e.label)) : sorted;
  }, [filteredEvents, importantOnly, IMPORTANT_LABELS]);

  // Update near-event cache whenever filteredEvents changes so the RAF
  // magnetization loop has an up-to-date sorted list to work with.
  useEffect(() => {
    const sorted = [...filteredEvents].sort((a, b) => a.start_ts - b.start_ts);
    const next = sorted.find(e => e.start_ts > (cursorTsRef.current ?? 0)) ?? null;
    nearEventCacheRef.current = { sorted, event: next };
  }, [filteredEvents]);

  // ─── Range change — kept for SplitView backward compat ───
  const handleRangeChange = useCallback((newStart, newEnd) => {
    const newRange = newEnd - newStart;
    if (newRange < MIN_RANGE_SEC || newRange > MAX_RANGE_SEC) return;
    setRangeSec(newRange);
    setCursorTs(newStart + newRange / 2);
  }, []);

  // ─── Scrub handler: sets hover position for preview overlay ───
  // cursorTs is NOT updated on hover — only clicking (handleSeek) recenters the view.
  // TODO: verify markInteraction is called on all user input paths (scroll, click, keyboard).
  const handleScrub = useCallback((ts) => {
    lastInteractionRef.current = Date.now();
    autoplayActiveRef.current = false;
    const snapped = snapToCoverage(ts, timelineData?.segments);
    setHoverTs(snapped);
  }, [timelineData]);

  // ─── Scrub end: clear hover ───
  const handleScrubEnd = useCallback(() => {
    setHoverTs(null);
  }, []);

  // ─── Pan: shift cursorTs by deltaSec, clamping at nowTs() ───
  const handlePan = useCallback((deltaSec) => {
    lastInteractionRef.current = Date.now();
    autoplayActiveRef.current = false;
    setCursorTs(prev => Math.min(prev + deltaSec, nowTs()));
  }, []);

  // ─── Zoom: change visible window width, keeping cursorTs fixed ───
  const handleZoomChange = useCallback((newRangeSec) => {
    lastInteractionRef.current = Date.now();
    autoplayActiveRef.current = false;
    if (newRangeSec < MIN_RANGE_SEC || newRangeSec > MAX_RANGE_SEC) return;
    setRangeSec(newRangeSec);
  }, []);

  // ─── Seek handler: commits playback, clears hover + snapshot ───
  const handleSeek = useCallback(
    async (ts) => {
      if (!selectedCamera) return;
      lastInteractionRef.current = Date.now();
      autoplayActiveRef.current = false;
      setHoverTs(null);
      setCursorTs(ts);
      setActiveEventSnapshot(null);

      try {
        const target = await fetchPlaybackTarget(selectedCamera, ts);
        console.log('[APP] setPlaybackTarget from timeline click/seek', target);
        setPlaybackTarget(target);
        setError(null);
      } catch (err) {
        setError(`Playback failed: ${err.message}`);
      }
    },
    [selectedCamera]
  );

  // ─── Segment advance: resolves nextSegmentId → start_ts via fetchSegmentInfo ───
  // Previously read playbackTargetRef directly, which could be null after a camera
  // switch, causing fetchPlaybackTarget to be called at ts=0. Now uses the
  // segment ID VideoPlayer provides, with a ref-based fallback if the lookup fails.
  // TODO: add frontend test verifying onSegmentAdvance is stable across cursorTs updates.
  const handleSegmentAdvance = useCallback(
    async (nextSegmentId) => {
      if (!selectedCamera || !nextSegmentId) return;
      try {
        const info = await fetchSegmentInfo(nextSegmentId);
        const target = await fetchPlaybackTarget(selectedCamera, info.start_ts + 0.1);
        console.log('[APP] setPlaybackTarget from auto-advance', target);
        setPlaybackTarget(target);
      } catch {
        // Fallback: use segment_end_ts from the ref if segment info lookup fails.
        const fallbackTs = playbackTargetRef.current?.segment_end_ts;
        if (fallbackTs) {
          try {
            const target = await fetchPlaybackTarget(selectedCamera, fallbackTs + 0.1);
            setPlaybackTarget(target);
          } catch {}
        }
      }
    },
    [selectedCamera]
  );

  // ─── Playback time tracking ───
  const handlePlaybackTimeUpdate = useCallback((absoluteTs) => {
    setCursorTs(absoluteTs);
  }, []);

  // ─── Playback start: dismiss event snapshot overlay ───
  const handlePlaybackStart = useCallback(() => {
    setActiveEventSnapshot(null);
  }, []);

  // ─── Camera switch ───
  // Uses cam.latest_ts (from /api/cameras) so the new camera's reticle lands at
  // its most recent footage rather than the previous camera's time position.
  // Falls back to nowTs() — never sets cursorTs to null which would NaN-cascade
  // into rangeStart/rangeEnd, API fetches, and the autoplay RAF loop.
  const handleCameraChange = useCallback((name) => {
    setSelectedCamera(name);
    const cam = cameras.find(c => c.name === name);
    setCursorTs(cam?.latest_ts ?? nowTs());
    setHoverTs(null);
    setPlaybackTarget(null);
    setTimelineData(null);
    setDensityData(null);
    setPreviewFrames([]);
    setActiveEventSnapshot(null);
    setCurrentEventIndex(null);
  }, [cameras]);

  // ─── Multi-camera selection ───
  const handleSelectMany = useCallback((names) => {
    setSelectedCameras(names);
    if (names.length >= 2) {
      setMultiMode(true);
    } else if (names.length === 0) {
      setMultiMode(false);
    }
  }, []);

  const handleToggleMultiMode = useCallback(() => {
    setMultiMode((v) => !v);
    if (multiMode) {
      setSelectedCameras([]);
    }
  }, [multiMode]);

  // ─── Range presets: snap cursorTs to now so reticle shows current time ───
  const setRange = useCallback((hours) => {
    setRangeSec(hours * 3600);
    setCursorTs(nowTs());
  }, []);

  // ─── "Go to" handler: recenter view on ts, rangeSec unchanged ───
  const handleGoto = useCallback(() => {
    if (!gotoValue) return;
    const ts = new Date(gotoValue).getTime() / 1000;
    if (isNaN(ts)) return;
    setCursorTs(ts);
    // Also load playback at the target ts
    handleSeek(ts);
  }, [gotoValue, handleSeek]);

  // ─── Label filter handlers ───
  const toggleLabel = useCallback((label) => {
    setActiveLabels(prev => {
      const current = prev ?? new Set(availableLabels);
      const next = new Set(current);
      if (next.has(label)) { next.delete(label); } else { next.add(label); }
      try {
        localStorage.setItem('frigate-active-labels', JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, [availableLabels]);

  const toggleAllLabels = useCallback(() => {
    setActiveLabels(null);
    try { localStorage.removeItem('frigate-active-labels'); } catch {}
  }, []);

  // ─── Event navigation ───
  const navigateEvent = useCallback(async (direction) => {
    if (!navEvents.length) return;
    const current = cursorTs ?? 0;

    let targetIdx;
    if (direction === 'next') {
      const idx = navEvents.findIndex(e => e.start_ts > current + 1);
      targetIdx = idx >= 0 ? idx : 0;
    } else {
      const idx = [...navEvents].map((e, i) => i).reverse().find(
        i => navEvents[i].start_ts < current - 1
      );
      targetIdx = idx != null ? idx : navEvents.length - 1;
    }

    const target = navEvents[targetIdx];
    setCurrentEventIndex(targetIdx);

    if (!target) return;

    setCursorTs(target.start_ts);
    try {
      const playTarget = await fetchPlaybackTarget(selectedCamera, target.start_ts);
      console.log('[APP] setPlaybackTarget from event navigation', playTarget);
      setPlaybackTarget(playTarget);
    } catch {}

    if (target.has_snapshot) {
      setActiveEventSnapshot({
        url: eventSnapshotUrl(target.id),
        label: target.label,
        score: target.score,
        ts: target.start_ts,
      });
    } else {
      setActiveEventSnapshot(null);
    }

    // setCursorTs(target.start_ts) above recenters the derived range automatically
  }, [navEvents, cursorTs, selectedCamera]);

  // ─── Derive scrub preview URL ───
  const activePreviewUrl =
    hoverTs != null && selectedCamera
      ? `/api/preview/${selectedCamera}/${hoverTs}`
      : null;

  // ─── Derive autoplayState from refs at render time ───
  // Refs don't trigger renders, but cursorTs updating ~60fps during autoplay means
  // this is re-evaluated each frame. Safe to read refs during render in React.
  let autoplayState = 'idle';
  if (autoplayActiveRef.current) {
    const nextEvent = nearEventCacheRef.current.event;
    if (nextEvent) {
      const distSec = nextEvent.start_ts - cursorTs;
      if (distSec > 0 && distSec < 10) {
        autoplayState = 'approaching_event';
      } else {
        autoplayState = 'advancing';
      }
    } else {
      autoplayState = 'advancing';
    }
  }

  // ─── Render ───
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Connecting to Accelerator backend...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      {isMobile ? (
        <div style={{ marginBottom: 8, borderBottom: '1px solid #2a2d37', paddingBottom: 6, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: health?.frigate_reachable ? '#4CAF50' : '#f44',
                display: 'inline-block',
              }} />
              <span style={{ fontSize: 17, fontWeight: 600, color: '#e0e0e0' }}>Frigate</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setHealthExpanded(v => !v)}
                style={{ background: 'none', border: 'none', color: '#666', fontSize: 18, cursor: 'pointer', padding: '0 4px' }}
              >⋯</button>
              <button
                onClick={() => setOpsOpen(true)}
                style={{ background: 'none', border: 'none', color: '#666', fontSize: 20, cursor: 'pointer', padding: '0 4px' }}
              >☰</button>
            </div>
          </div>
          {healthExpanded && health && (
            <div style={{ fontSize: 13, color: '#888', paddingBottom: 4 }}>
              {health.total_segments.toLocaleString()} segs ·{' '}
              {health.total_previews.toLocaleString()} previews ·{' '}
              {health.pending_previews.toLocaleString()} pending
            </div>
          )}
        </div>
      ) : (
        <div style={styles.header}>
          <h1 style={styles.title}>Frigate Review Accelerator</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {health && (
              <div style={styles.healthBadge}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: health.frigate_reachable ? '#4CAF50' : '#f44',
                    marginRight: 6,
                  }}
                />
                {health.total_segments.toLocaleString()} segs
                {' · '}
                {health.total_previews.toLocaleString()} previews
                {health.pending_previews > 0 && (
                  <span style={{ color: '#888' }}>
                    {' · '}{health.pending_previews.toLocaleString()} pending
                  </span>
                )}
              </div>
            )}
            <button
              onClick={() => setOpsOpen(true)}
              style={{
                background: 'none',
                border: '1px solid #2a2d37',
                color: '#666',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              title="Ops panel"
            >☰</button>
          </div>
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {/* Controls — final layout: Camera → Filters → Events → Auto → Zoom → Goto → Split */}
      {isMobile ? (
        <div style={{ flexShrink: 0, marginBottom: 8 }}>
          {/* Row 1: Camera (full width) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {!multiMode ? (
                <CameraSelector cameras={cameras} selected={selectedCamera} onSelect={handleCameraChange} isMobile={true} />
              ) : (
                <CameraSelector cameras={cameras} selectedMany={selectedCameras} onSelectMany={handleSelectMany} multiMode={true} maxSelect={4} isMobile={true} />
              )}
            </div>
            <button
              onClick={handleToggleMultiMode}
              style={{ ...styles.rangeBtn, borderColor: multiMode ? '#2196F3' : '#333', color: multiMode ? '#2196F3' : '#aaa', padding: '10px 16px', fontSize: '15px', minHeight: 44, flexShrink: 0 }}
            >{multiMode ? '◈ Single' : '◈ Split'}</button>
          </div>

          {/* Row 2: Filter pills (horizontal scroll) */}
          {!multiMode && availableLabels.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 6, paddingBottom: 2 }}>
              <LabelFilterPills
                availableLabels={availableLabels}
                activeLabels={activeLabels}
                onToggle={toggleLabel}
                onToggleAll={toggleAllLabels}
                labelCounts={labelCounts}
                isMobile={true}
              />
            </div>
          )}

          {/* Row 3: Event nav + autoplay + zoom presets (horizontal scroll, no goto) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', overflowX: 'auto' }}>
            {!multiMode && navEvents.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid #333', borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#e0e0e0', flexShrink: 0 }}>
                  <button onClick={() => navigateEvent('prev')} style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, padding: 0, fontFamily: 'monospace' }}>◀</button>
                  <span>EVENT {currentEventIndex != null ? currentEventIndex + 1 : '—'} / {navEvents.length}{importantOnly && ' ⚡'}</span>
                  <button onClick={() => navigateEvent('next')} style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, padding: 0, fontFamily: 'monospace' }}>▶</button>
                </div>
                <button onClick={() => { setImportantOnly(v => !v); setCurrentEventIndex(null); }} style={{ ...styles.iconBtn, borderColor: importantOnly ? '#4dd0e1' : '#333', color: importantOnly ? '#4dd0e1' : '#666', background: importantOnly ? 'rgba(77,208,225,0.1)' : 'rgba(255,255,255,0.04)', flexShrink: 0 }} title="Important only">⚡</button>
              </>
            )}
            {!multiMode && (
              <button
                onClick={() => { setAutoplayEnabled(v => { const next = !v; try { localStorage.setItem('frigate-autoplay-enabled', String(next)); } catch {} if (!next) autoplayActiveRef.current = false; return next; }); }}
                style={{ ...styles.iconBtn, borderColor: autoplayEnabled ? '#4dd0e1' : '#333', color: autoplayEnabled ? '#4dd0e1' : '#666', background: autoplayEnabled ? 'rgba(77,208,225,0.1)' : 'rgba(255,255,255,0.04)', fontSize: 11, flexShrink: 0 }}
              >{autoplayEnabled ? '▶ Auto' : '⏸ Auto'}</button>
            )}
            {[1, 4, 8, 24].map((h) => (
              <button key={h} onClick={() => setRange(h)} style={{ ...styles.rangeBtn, padding: '10px 16px', fontSize: '15px', minHeight: 44, flexShrink: 0 }}>{h}h</button>
            ))}
          </div>
        </div>
      ) : (
        /* Desktop: single row — Camera → Filters → [spacer] → Events → Auto → Zoom → Goto → Split */
        <div style={styles.controls}>
          {/* 1. Camera */}
          {!multiMode ? (
            <CameraSelector cameras={cameras} selected={selectedCamera} onSelect={handleCameraChange} />
          ) : (
            <CameraSelector cameras={cameras} selectedMany={selectedCameras} onSelectMany={handleSelectMany} multiMode={true} maxSelect={4} />
          )}

          {/* 2. Filter pills — inline, no "Filter:" label */}
          {!multiMode && availableLabels.length > 0 && (
            <LabelFilterPills
              availableLabels={availableLabels}
              activeLabels={activeLabels}
              onToggle={toggleLabel}
              onToggleAll={toggleAllLabels}
              labelCounts={labelCounts}
            />
          )}

          <div style={{ flex: 1 }} />

          {/* 3. Event nav + ⚡ */}
          {!multiMode && navEvents.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid #333', borderRadius: 6, padding: '4px 12px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#e0e0e0' }}>
                <button onClick={() => navigateEvent('prev')} style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, padding: 0, fontFamily: 'monospace' }} onMouseEnter={e => e.target.style.color = '#4dd0e1'} onMouseLeave={e => e.target.style.color = '#aaa'} title="Previous event">◀</button>
                <span>EVENT {currentEventIndex != null ? currentEventIndex + 1 : '—'} / {navEvents.length}{importantOnly && ' ⚡'}</span>
                <button onClick={() => navigateEvent('next')} style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, padding: 0, fontFamily: 'monospace' }} onMouseEnter={e => e.target.style.color = '#4dd0e1'} onMouseLeave={e => e.target.style.color = '#aaa'} title="Next event">▶</button>
              </div>
              <button onClick={() => { setImportantOnly(v => !v); setCurrentEventIndex(null); }} title={importantOnly ? 'Important only — click for all' : 'Click for important only'} style={{ ...styles.iconBtn, borderColor: importantOnly ? '#4dd0e1' : '#333', color: importantOnly ? '#4dd0e1' : '#666', background: importantOnly ? 'rgba(77,208,225,0.1)' : 'rgba(255,255,255,0.04)' }}>⚡</button>
            </>
          )}

          {/* 4. Autoplay toggle */}
          {!multiMode && (
            <button
              onClick={() => { setAutoplayEnabled(v => { const next = !v; try { localStorage.setItem('frigate-autoplay-enabled', String(next)); } catch {} if (!next) autoplayActiveRef.current = false; return next; }); }}
              title={autoplayEnabled ? 'Autoplay on — click to pause' : 'Autoplay off — click to enable'}
              style={{ ...styles.iconBtn, borderColor: autoplayEnabled ? '#4dd0e1' : '#333', color: autoplayEnabled ? '#4dd0e1' : '#666', background: autoplayEnabled ? 'rgba(77,208,225,0.1)' : 'rgba(255,255,255,0.04)', fontSize: 12 }}
            >{autoplayEnabled ? '▶ Auto' : '⏸ Auto'}</button>
          )}

          {/* 5. Zoom presets */}
          <div style={styles.rangeButtons}>
            {[1, 4, 8, 24].map((h) => (
              <button key={h} onClick={() => setRange(h)} style={styles.rangeBtn}>{h}h</button>
            ))}
          </div>

          {/* 6. Goto — far right, single-camera only */}
          {!multiMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#666', fontSize: 13 }}>Go to:</span>
              <input
                type="datetime-local"
                value={gotoValue}
                onChange={(e) => setGotoValue(e.target.value)}
                style={{ colorScheme: 'dark', background: '#1a1d27', border: '1px solid #333', color: '#aaa', padding: '3px 6px', borderRadius: 4, fontSize: 13 }}
              />
              <button onClick={handleGoto} style={styles.rangeBtn}>Go</button>
            </div>
          )}

          {/* 7. Split — far right */}
          <button
            onClick={handleToggleMultiMode}
            style={{ ...styles.rangeBtn, borderColor: multiMode ? '#2196F3' : '#333', color: multiMode ? '#2196F3' : '#aaa' }}
          >{multiMode ? '◈ Single' : '◈ Split'}</button>
        </div>
      )}

      {/* Main content */}
      {multiMode && selectedCameras.length >= 2 ? (
        /* ── Split view (unchanged) ── */
        <SplitView
          cameras={selectedCameras}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onRangeChange={handleRangeChange}
        />
      ) : !multiMode ? (
        /* ── Single-camera: 2-column layout ── */
        <div style={{
          ...styles.singleLayout,
          flexDirection: isMobile ? 'column' : 'row',
          overflow: 'hidden',
        }}>
          {/* Left/top: video viewer column */}
          <div style={{ ...styles.viewerCol, flex: isMobile ? 'none' : 1 }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <VideoPlayer
                playbackTarget={playbackTarget}
                camera={selectedCamera}
                onTimeUpdate={handlePlaybackTimeUpdate}
                onSegmentAdvance={handleSegmentAdvance}
                scrubPreviewUrl={activePreviewUrl}
                isMobile={isMobile}
                eventSnapshot={activeEventSnapshot}
                onSeek={handleSeek}
                onPlaybackStart={handlePlaybackStart}
              />
            </div>

            {/* Footer: timestamp + coverage stats */}
            <div style={styles.viewerFooter}>
              <span style={styles.timestamp}>
                {cursorTs ? (isMobile ? formatTime(cursorTs) : formatDateTime(cursorTs)) : '—'}
              </span>
              {timelineData && (
                <span style={styles.coverageStats}>
                  {timelineData.segments.length} segs ·{' '}
                  {timelineData.coverage_pct.toFixed(1)}% cov ·{' '}
                  {filteredEvents.length} evt
                </span>
              )}
            </div>
          </div>

          {/* Right/bottom: vertical timeline column */}
          <div style={{
            ...styles.timelineCol,
            width: isMobile ? '100%' : 230,
            flex: isMobile ? 1 : undefined,
            minHeight: isMobile ? 320 : undefined,
            flexShrink: isMobile ? undefined : 0,
          }}>
            {/* Top range label */}
            <div style={styles.rangeLabel}>
              {new Date(rangeStart * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>

            {/* VerticalTimeline */}
            <div style={{ flex: 1, minHeight: 0 }}>
              <VerticalTimeline
                startTs={rangeStart}
                endTs={rangeEnd}
                gaps={timelineData?.gaps || []}
                events={filteredEvents}
                densityData={densityData}
                activeLabels={activeLabels}
                cursorTs={cursorTs}
                onScrub={handleScrub}
                onScrubEnd={handleScrubEnd}
                onSeek={handleSeek}
                onPan={handlePan}
                onZoomChange={handleZoomChange}
                autoplayState={autoplayState}
                isMobile={isMobile}
                onPreviewRequest={(ts) => {
                  const halfWindow = 5 * 60;
                  requestPreviews(selectedCamera, ts - halfWindow, ts + halfWindow).catch(() => {});
                }}
              />
            </div>

            {/* Bottom range label */}
            <div style={{ ...styles.rangeLabel, borderTop: '1px solid #1e2130', borderBottom: 'none' }}>
              {new Date(rangeEnd * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </div>
        </div>
      ) : (
        /* ── Split mode: not enough cameras selected ── */
        <div style={styles.splitHint}>
          Select 2–4 cameras above to enable split view.
        </div>
      )}

      <AdminPanel open={opsOpen} onClose={() => setOpsOpen(false)} />
    </div>
  );
}

const styles = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    padding: '10px 14px 0',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    borderBottom: '1px solid #2a2d37',
    paddingBottom: 8,
    flexShrink: 0,
  },
  title: { fontSize: 27, fontWeight: 600, color: '#e0e0e0', margin: 0 },
  healthBadge: { fontSize: 17, color: '#888', display: 'flex', alignItems: 'center' },
  error: {
    background: '#3a1515',
    border: '1px solid #5a2020',
    color: '#f88',
    padding: '6px 12px',
    borderRadius: 4,
    marginBottom: 8,
    fontSize: 19,
    flexShrink: 0,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  rangeButtons: { display: 'flex', gap: 4 },
  rangeBtn: {
    background: '#1a1d27',
    border: '1px solid #333',
    color: '#aaa',
    padding: '4px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 16,
  },
  iconBtn: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid #333',
    color: '#666',
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: 14,
  },
  singleLayout: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    gap: 8,
    paddingBottom: 10,
    overflow: 'hidden',
  },
  viewerCol: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  viewerFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexShrink: 0,
    padding: '2px 0',
  },
  timestamp: {
    color: '#4CAF50',
    fontSize: 17,
    fontFamily: 'monospace',
  },
  coverageStats: {
    color: '#444',
    fontSize: 16,
  },
  timelineCol: {
    width: 230,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0c12',
    border: '1px solid #1a1d27',
    borderRadius: 6,
    overflow: 'hidden',
  },
  rangeLabel: {
    padding: '4px 0',
    textAlign: 'center',
    fontSize: 16,
    color: '#555',
    borderBottom: '1px solid #1e2130',
    flexShrink: 0,
    fontFamily: 'monospace',
  },
  loading: { color: '#888', textAlign: 'center', paddingTop: 100, fontSize: 16 },
  splitHint: {
    textAlign: 'center',
    color: '#555',
    fontSize: 13,
    padding: '40px 0',
    border: '1px dashed #2a2d37',
    borderRadius: 6,
    marginTop: 12,
  },
};
