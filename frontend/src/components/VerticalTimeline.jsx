/**
 * VerticalTimeline — Full-height vertical canvas timeline.
 *
 * Time flows top (startTs) → bottom (endTs).
 *
 * Horizontal zones (left to right):
 *   [0 … 58px]      — time tick labels (right-aligned, monospace 11px)
 *   [58px]           — 1px separator line
 *   [59 … w-18px]    — bar zone: density gradient, detection ticks, event markers
 *   [w-18px … w]     — right edge (used by important-event diamond markers)
 *
 * Drawing order (bottom layer → top):
 *   1.  Background
 *   2.  Vertical separator lines
 *   3.  Gap absence fill (subtle dark)
 *   4.  Layer 1: Density gradient (interpolated Float32Array, blue spectrum)
 *   5.  "Now" dashed line (current wall-clock time, if in range)
 *   6.  Time tick labels + hairlines (proximity fade from reticle)
 *   7.  Layer 2: Detection ticks with proximity-aware labels
 *   8.  Layer 3: Important event markers (amber-red, diamond, snapshot dot)
 *   9.  Hover line (yellow, mouse position)
 *   10. Reticle: glow band + two thin lines + timestamp badge
 *
 * Interaction model (fixed-reticle / radar):
 *   - Reticle is physically fixed at h * RETICLE_FRACTION from top.
 *   - Scroll = pan: timeline flows under the reticle (onPan callback).
 *   - Click = recenter: clicked ts moves to reticle with 250ms ease-out animation.
 *   - Zoom: −/slider/+ strip calls onZoomChange with a new rangeSec value.
 *
 * Animation invariant: the 250ms cursor interpolation uses refs + rAF exclusively
 * — no setState per frame. Canvas reads from displayCursorRef when animation
 * is active, falling back to the cursorTs prop when idle.
 */

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { formatTimeShort, clampTs, nowTs } from '../utils/time.js';
import { RETICLE_FRACTION } from '../utils/constants.js';

function useDebounce(fn, delay) {
  const timer = useRef(null);
  return useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

const LABEL_WIDTH = 58;
const EVENT_WIDTH = 18;

// Named presets for quick-jump buttons (spec Section 6)
const ZOOM_PRESETS = [
  { label: '30m', sec: 30 * 60 },
  { label: '1h',  sec: 60 * 60 },
  { label: '8h',  sec: 8 * 3600 },
  { label: '24h', sec: 24 * 3600 },
];

// Full slider stops — kept for smooth fine-grained zooming
const ZOOM_STOPS = [
  5 * 60,         // 5m
  8 * 60,         // 8m
  10 * 60,        // 10m
  15 * 60,        // 15m
  20 * 60,        // 20m
  30 * 60,        // 30m
  45 * 60,        // 45m
  60 * 60,        // 1h
  2 * 3600,       // 2h
  4 * 3600,       // 4h
  8 * 3600,       // 8h
  12 * 3600,      // 12h
  18 * 3600,      // 18h
  24 * 3600,      // 24h
  48 * 3600,      // 48h
  7 * 24 * 3600,  // 7d
];

const ZOOM_STOP_LABELS = [
  '5m', '8m', '10m', '15m', '20m', '30m', '45m',
  '1h', '2h', '4h', '8h', '12h', '18h', '24h', '48h', '7d',
];

/**
 * Zoom-aware base pan amount in seconds per scroll tick.
 * Slower at fine zoom (precise positioning), faster at wide zoom (quick navigation).
 * TODO: unit test velocity calculation — verify multiplier caps at 4x, window prunes correctly
 */
function panAmountSec(rangeSec) {
  if (rangeSec <= 1800)  return rangeSec * 0.03;  // ≤30m → 3%
  if (rangeSec <= 3600)  return rangeSec * 0.05;  // ≤1h  → 5%
  if (rangeSec <= 28800) return rangeSec * 0.08;  // ≤8h  → 8%
  return rangeSec * 0.12;                          // >8h  → 12%
}

const EVENT_COLORS = {
  person: '#4CAF50',
  car: '#2196F3',
  dog: '#FF9800',
  cat: '#9C27B0',
  default: '#607D8B',
};

/** Return the ZOOM_STOPS index whose value is nearest to the given range. */
function nearestZoomIdx(rangeSec) {
  let best = 0;
  let bestDiff = Math.abs(ZOOM_STOPS[0] - rangeSec);
  for (let i = 1; i < ZOOM_STOPS.length; i++) {
    const diff = Math.abs(ZOOM_STOPS[i] - rangeSec);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

const btnStyle = {
  width: 28,
  height: 28,
  background: '#1a1d27',
  border: '1px solid #333',
  color: '#aaa',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 16,
  fontFamily: 'monospace',
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default function VerticalTimeline({
  startTs,
  endTs,
  gaps = [],
  events = [],
  densityData = null,
  activeLabels = null,
  cursorTs,
  autoplayState = 'idle',
  onSeek,
  onPan,
  onZoomChange,
  onPreviewRequest = null,
  isMobile = false,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const isDragging = useRef(false);
  const touchStartRef = useRef(null);
  const scrollTimestamps = useRef([]);

  // Animation refs — no state to avoid per-frame re-renders
  // TODO: verify animation ref doesn't leak — must cancel on unmount and on new click during active animation
  const displayCursorRef = useRef(cursorTs);  // what the canvas currently displays
  const animRef = useRef(null);               // { from, to, startTime, rafId } | null
  const drawCanvasRef = useRef(null);         // always points to latest draw fn

  const [dims, setDims] = useState({ w: 215, h: 600 });

  const debouncedPreviewRequest = useDebounce(
    (ts) => { if (onPreviewRequest) onPreviewRequest(ts); },
    300
  );

  const range = endTs - startTs;

  // Derive zoom index from live range (no separate state — always in sync)
  const zoomIdx = nearestZoomIdx(range);

  // Explicit seconds-per-pixel mapping — used by tsToY/yToTs and canvas rendering.
  // Derived, never stored as state. Required by PR4 density gradient rendering.
  const secondsPerPixel = useMemo(
    () => (dims.h > 0 ? (endTs - startTs) / dims.h : 1),
    [startTs, endTs, dims.h]
  );

  const tsToY = useCallback(
    (ts) => (ts - startTs) / secondsPerPixel,
    [startTs, secondsPerPixel]
  );

  const yToTs = useCallback(
    (y) => clampTs(startTs + y * secondsPerPixel, startTs, endTs),
    [startTs, endTs, secondsPerPixel]
  );

  // ── ResizeObserver ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDims({ w: Math.max(width, 1), h: Math.max(height, 1) });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Canvas draw function ────────────────────────────────────────────────────
  // Extracted as useCallback so it can be called both from the data-change
  // useEffect and imperatively from the animation rAF loop.
  // Reads displayCursorRef.current for cursor position — never from the prop
  // directly, so animation interpolation is reflected without setState.
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { w, h } = dims;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const barStart = LABEL_WIDTH + 1;
    const barEnd = w - EVENT_WIDTH;
    const barW = barEnd - barStart;
    const reticleY = h * RETICLE_FRACTION;

    // Local spp for y → ts direction in density precomputation.
    // Same value as secondsPerPixel — computed locally to avoid extra dep.
    const spp = h > 0 ? (endTs - startTs) / h : 1;

    // 1. Background
    ctx.fillStyle = '#090b10';
    ctx.fillRect(0, 0, LABEL_WIDTH, h);
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(LABEL_WIDTH, 0, w - LABEL_WIDTH, h);

    // 2. Separator lines
    ctx.fillStyle = '#1e2130';
    ctx.fillRect(LABEL_WIDTH, 0, 1, h);
    ctx.fillRect(barEnd, 0, 1, h);

    // 3. Gap absence indication — subtle dark fill (no hatching)
    for (const gap of gaps) {
      const y1 = Math.max(0, tsToY(gap.start_ts));
      const y2 = Math.min(h, tsToY(gap.end_ts));
      if (y2 - y1 < 1) continue;
      ctx.fillStyle = 'rgba(15, 5, 5, 0.3)';
      ctx.fillRect(barStart, y1, barW, y2 - y1);
    }

    // 4. Layer 1: Density gradient
    // TODO: extract _buildDensityArray(buckets, h, startTs, spp) as a pure
    // function for unit testing — maps pixel rows to interpolated density.
    // TODO: unit test client-side filter — verify effectiveTotal excludes filtered labels
    // when activeLabels is set, e.g. turning off "car" reduces density in car-heavy buckets.
    if (densityData?.buckets?.length > 0) {
      const buckets = densityData.buckets;

      // Client-side label filtering: density endpoint returns all labels per bucket.
      // When activeLabels is set, sum only the active label counts for the gradient.
      // Invariant: if "car" is off, car counts are excluded from density AND ticks AND markers.
      // Ticks/markers use `events` (already filteredEvents from App.jsx) — no change needed there.
      function effectiveTotal(bucket) {
        if (activeLabels === null) return bucket.total;
        return Object.entries(bucket.counts)
          .filter(([label]) => activeLabels.has(label))
          .reduce((sum, [, count]) => sum + count, 0);
      }

      const maxTotal = Math.max(...buckets.map((b) => effectiveTotal(b)), 1);

      // Precompute Float32Array of normalized density per pixel row.
      // O(h + n_buckets): monotonic pointer works because y→ts is increasing.
      const densityArr = new Float32Array(h);
      let bi = 0;
      for (let y = 0; y < h; y++) {
        const ts = startTs + y * spp;
        while (bi < buckets.length - 1 && buckets[bi + 1].ts <= ts) bi++;
        const lo = buckets[bi];
        const hi = bi + 1 < buckets.length ? buckets[bi + 1] : null;
        let norm;
        if (hi) {
          const span = hi.ts - lo.ts;
          const t = span > 0 ? Math.max(0, Math.min(1, (ts - lo.ts) / span)) : 0;
          norm = (effectiveTotal(lo) * (1 - t) + effectiveTotal(hi) * t) / maxTotal;
        } else {
          norm = effectiveTotal(lo) / maxTotal;
        }
        densityArr[y] = Math.max(0, Math.min(1, norm));
      }

      // 3-tap box blur to soften gradient edges
      const blurred = new Float32Array(h);
      for (let y = 0; y < h; y++) {
        const prev = y > 0 ? densityArr[y - 1] : densityArr[y];
        const next = y < h - 1 ? densityArr[y + 1] : densityArr[y];
        blurred[y] = 0.25 * prev + 0.5 * densityArr[y] + 0.25 * next;
      }

      // Render 1px rows — color mapped from density (blue spectrum)
      for (let y = 0; y < h; y++) {
        const n = blurred[y];
        if (n < 0.01) continue;
        let r, g, b, a;
        if (n < 0.25) {
          const t = n / 0.25;
          r = 20; g = 50; b = 110; a = 0.04 + t * 0.08;
        } else if (n < 0.5) {
          const t = (n - 0.25) / 0.25;
          r = 30; g = 80; b = 150; a = 0.12 + t * 0.13;
        } else if (n < 0.75) {
          const t = (n - 0.5) / 0.25;
          r = 40; g = 130; b = 190; a = 0.25 + t * 0.20;
        } else {
          const t = (n - 0.75) / 0.25;
          r = 80; g = 190; b = 230; a = 0.45 + t * 0.20;
        }
        ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
        ctx.fillRect(barStart, y, barW, 1);
      }
    }

    // 5. "Now" dashed line (green, if wall-clock is within range)
    const currentWallTs = nowTs();
    if (currentWallTs >= startTs && currentWallTs <= endTs) {
      const ny = tsToY(currentWallTs);
      ctx.save();
      ctx.strokeStyle = 'rgba(76,200,80,0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(barStart, ny);
      ctx.lineTo(barEnd, ny);
      ctx.stroke();
      ctx.restore();
    }

    // 6. Time tick labels + horizontal hairlines (proximity fade from reticle)
    // Fine-grained intervals (5/10/15/30s) support tight zoom levels.
    const TICK_INTERVALS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const MIN_TICK_SPACING_PX = 32;
    const maxTicks = Math.floor(h / MIN_TICK_SPACING_PX);
    const minIntervalSec = (endTs - startTs) / maxTicks;
    const tickSec = TICK_INTERVALS.find((t) => t >= minIntervalSec) ?? 86400;
    const maxFadeDistance = h * 0.4;

    const firstTick = Math.ceil(startTs / tickSec) * tickSec;
    for (let t = firstTick; t <= endTs; t += tickSec) {
      const y = tsToY(t);

      // Hairline across bar zone
      ctx.strokeStyle = '#1a1e2b';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(barStart, y);
      ctx.lineTo(barEnd, y);
      ctx.stroke();

      // Proximity fade: labels nearest reticle are brighter and bolder
      const distance = Math.abs(y - reticleY);
      const opacity = 1.0 - Math.min(distance / maxFadeDistance, 0.7);
      if (distance < 20) {
        ctx.font = 'bold 13px monospace';
        ctx.fillStyle = `rgba(180, 200, 220, ${opacity.toFixed(3)})`;
      } else {
        ctx.font = '11px monospace';
        ctx.fillStyle = `rgba(74, 79, 101, ${opacity.toFixed(3)})`;
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatTimeShort(t), LABEL_WIDTH - 4, y);
    }

    // 7. Layer 2: Detection ticks with proximity-aware labels
    // Ticks span 60% of bar zone width (centered). Opacity rises near reticle.
    // Labels only near reticle (±60px), with 14px collision avoidance.
    // TODO: extract _labelCollisionFilter(events, reticleY, tsToY) for unit testing.
    const tickBarStart = barStart + barW * 0.2;
    const tickBarEnd = barStart + barW * 0.8;
    const readingZoneEvents = [];

    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const evt of events) {
      const y = tsToY(evt.start_ts);
      if (y < -2 || y > h + 2) continue;

      const distFromReticle = Math.abs(y - reticleY);
      const color = EVENT_COLORS[evt.label] || EVENT_COLORS.default;

      ctx.globalAlpha = distFromReticle <= 40 ? 0.9 : 0.6;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(tickBarStart, y);
      ctx.lineTo(tickBarEnd, y);
      ctx.stroke();

      if (distFromReticle <= 60) {
        readingZoneEvents.push({ evt, y, distFromReticle });
      }
    }
    ctx.globalAlpha = 1;

    // Labels: closest to reticle first; skip if within 14px of an already-labeled event
    // TODO: unit test — given N events within ±60px, only the closest group with
    // ≥14px spacing should receive labels; all others should be unlabeled ticks.
    readingZoneEvents.sort((a, b) => a.distFromReticle - b.distFromReticle);
    const labeledYs = [];
    for (const { evt, y } of readingZoneEvents) {
      if (labeledYs.some((ly) => Math.abs(y - ly) < 14)) continue;
      labeledYs.push(y);
      ctx.fillStyle = EVENT_COLORS[evt.label] || EVENT_COLORS.default;
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(evt.label, LABEL_WIDTH - 4, y);
    }

    // 8. Layer 3: Important event markers (amber-red, 2px line + diamond)
    // Cross-references density buckets (important=true) with individual events.
    // TODO: extract _importantEvents(events, densityBuckets, bucketSec) for testing.
    if (densityData?.buckets?.length > 0) {
      const bSec = densityData.bucket_sec || 15;
      const importantStarts = new Set(
        densityData.buckets.filter((b) => b.important).map((b) => b.ts)
      );
      const importantColor = 'rgba(220, 80, 60, 0.7)';

      for (const evt of events) {
        const bucketStart = Math.floor(evt.start_ts / bSec) * bSec;
        if (!importantStarts.has(bucketStart)) continue;

        const y = tsToY(evt.start_ts);
        if (y < -2 || y > h + 2) continue;

        // 2px full-width line
        ctx.strokeStyle = importantColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(barStart, y);
        ctx.lineTo(barEnd, y);
        ctx.stroke();

        // Diamond at right edge of bar zone
        const dm = 4;
        ctx.fillStyle = importantColor;
        ctx.beginPath();
        ctx.moveTo(barEnd, y - dm);
        ctx.lineTo(barEnd + dm, y);
        ctx.lineTo(barEnd, y + dm);
        ctx.lineTo(barEnd - dm, y);
        ctx.closePath();
        ctx.fill();

        // Snapshot indicator dot at left edge
        if (evt.has_snapshot) {
          ctx.beginPath();
          ctx.arc(barStart + 4, y, 2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(220, 80, 60, 0.9)';
          ctx.fill();
        }
      }
    }

    // 9. Reticle at fixed Y = h * RETICLE_FRACTION
    // The reticle Y is a constant — it never moves. cursorTs always maps here
    // by construction (rangeStart/rangeEnd are derived from cursorTs in App.jsx).
    const displayTs = displayCursorRef.current;
    if (displayTs != null) {
      // Reticle glow — color and intensity respond to autoplayState:
      //   'idle'             → base blue at 0.06 alpha
      //   'advancing'        → blue pulsing 0.06→0.12 on 3s sine (drawn at current time)
      //   'approaching_event'→ amber-red at 0.10 (distinct from density blue)
      let glowStyle;
      if (autoplayState === 'approaching_event') {
        glowStyle = 'rgba(220, 80, 60, 0.10)';
      } else if (autoplayState === 'advancing') {
        const t = (performance.now() / 3000) * Math.PI * 2;
        const alpha = (0.06 + 0.06 * (0.5 + 0.5 * Math.sin(t))).toFixed(3);
        glowStyle = `rgba(60, 160, 220, ${alpha})`;
      } else {
        glowStyle = 'rgba(60, 160, 220, 0.06)';
      }
      ctx.fillStyle = glowStyle;
      ctx.fillRect(barStart, reticleY - 20, barW, 40);

      // Two thin horizontal lines with a 20px gap between them
      ctx.strokeStyle = 'rgba(100, 180, 220, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(barStart, reticleY - 10);
      ctx.lineTo(barEnd, reticleY - 10);
      ctx.moveTo(barStart, reticleY + 10);
      ctx.lineTo(barEnd, reticleY + 10);
      ctx.stroke();

      // Timestamp badge centered in the gap
      const label = formatTimeShort(displayTs);
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textW = ctx.measureText(label).width;
      const badgePad = 4;
      const badgeCx = barStart + barW / 2;
      const badgeX = badgeCx - textW / 2 - badgePad;

      ctx.fillStyle = 'rgba(10, 20, 35, 0.88)';
      ctx.strokeStyle = 'rgba(100, 180, 220, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(badgeX, reticleY - 9, textW + badgePad * 2, 18);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(160, 210, 240, 0.95)';
      ctx.fillText(label, badgeCx, reticleY);
    }
  }, [dims, startTs, endTs, gaps, events, densityData, activeLabels, autoplayState, tsToY]);
  // Note: cursorTs is NOT a dep — read from displayCursorRef at draw time.

  // Keep drawCanvasRef pointing to the latest version of drawCanvas.
  // The rAF animation loop calls drawCanvasRef.current() so it always uses
  // current props even if the component re-rendered mid-animation.
  useEffect(() => { drawCanvasRef.current = drawCanvas; }, [drawCanvas]);

  // Trigger canvas redraw whenever draw deps change (data, layout, hover).
  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  // Sync displayCursorRef from cursorTs prop when no animation is running,
  // then immediately redraw so cursor position stays current during playback.
  useEffect(() => {
    if (!animRef.current) {
      displayCursorRef.current = cursorTs;
      drawCanvasRef.current?.();
    }
  }, [cursorTs]);

  // Cancel any in-flight animation on unmount.
  useEffect(() => {
    return () => {
      if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);
    };
  }, []);

  // ── Scroll-to-pan: zoom-aware sensitivity + velocity acceleration ────────────
  const handleWheel = useCallback(
    (e) => {
      if (!onPan) return;
      e.preventDefault();

      const now = Date.now();
      // Keep only timestamps within the 200ms velocity window
      scrollTimestamps.current = scrollTimestamps.current.filter(t => now - t < 200);
      scrollTimestamps.current.push(now);

      const count = scrollTimestamps.current.length;
      let delta = panAmountSec(range);
      // Velocity acceleration: >2 events in window → multiply, capped at 4×
      if (count > 2) {
        delta *= Math.min(count / 2, 4);
      }

      // deltaY < 0 = scroll up = go backward in time (earlier timestamps)
      onPan(e.deltaY < 0 ? -delta : delta);
    },
    [range, onPan]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ── Zoom: apply a stop index; App.jsx keeps cursorTs fixed while range changes ─
  const applyZoom = useCallback(
    (idx) => {
      const clamped = Math.max(0, Math.min(ZOOM_STOPS.length - 1, idx));
      if (onZoomChange) onZoomChange(ZOOM_STOPS[clamped]);
    },
    [onZoomChange]
  );

  // ── Mouse handlers ──────────────────────────────────────────────────────────
  const getTs = useCallback(
    (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return yToTs(e.clientY - rect.top);
    },
    [yToTs]
  );

  const handleMouseDown = useCallback(
    (e) => {
      isDragging.current = true;
    },
    []
  );

  const handleMouseMove = useCallback(
    (e) => {
      const ts = getTs(e);
      if (ts != null) debouncedPreviewRequest(ts);
    },
    [getTs, debouncedPreviewRequest]
  );

  // Click = recenter with 250ms ease-out animation.
  // Animation uses refs + rAF — no setState per frame.
  // The animation starts from the current displayCursorRef value (which may
  // itself be mid-animation if user clicks again before it finishes).
  const handleMouseUp = useCallback(
    (e) => {
      if (!isDragging.current) return;
      isDragging.current = false;

      const ts = getTs(e);
      if (ts == null) return;

      const from = displayCursorRef.current ?? ts;
      const startTime = performance.now();
      const DURATION_MS = 250;

      // Cancel any in-flight animation
      if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);

      function tick(now) {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / DURATION_MS, 1);
        // Ease-out cubic: fast start, decelerates to rest
        const eased = 1 - (1 - t) ** 3;
        displayCursorRef.current = from + (ts - from) * eased;
        drawCanvasRef.current?.();

        if (t < 1) {
          animRef.current.rafId = requestAnimationFrame(tick);
        } else {
          displayCursorRef.current = ts;
          animRef.current = null;
        }
      }

      animRef.current = { from, to: ts, startTime, rafId: requestAnimationFrame(tick) };

      // Notify App.jsx — sets cursorTs which recomputes rangeStart/rangeEnd
      if (onSeek) onSeek(ts);
    },
    [getTs, onSeek]
  );

  const handleMouseLeave = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        userSelect: 'none',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Canvas fills all remaining vertical space as a direct flex child */}
      <canvas
        ref={canvasRef}
        style={{ cursor: 'crosshair', display: 'block', flex: 1, minHeight: 0, touchAction: 'manipulation' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={(e) => {
          e.preventDefault();
          const touch = e.touches[0];
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
          handleMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
        }}
        onTouchMove={(e) => {
          e.preventDefault();
          const touch = e.touches[0];
          const dx = touch.clientX - (touchStartRef.current?.x ?? touch.clientX);
          const dy = touch.clientY - (touchStartRef.current?.y ?? touch.clientY);
          const isHorizontalSwipe = Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 10;

          if (isHorizontalSwipe && onPan) {
            // Horizontal swipe → pan: map swipe distance to time delta
            const fraction = -dx / dims.w * 0.5;
            onPan(range * fraction);
            touchStartRef.current = { x: touch.clientX, y: touch.clientY };
            return;
          }

          handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          const touch = e.changedTouches[0];
          handleMouseUp({ clientX: touch.clientX, clientY: touch.clientY });
        }}
      />

      {/* Zoom control strip */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '5px 8px 6px',
          flexShrink: 0,
          borderTop: '1px solid #1e2130',
          background: '#090b10',
        }}
      >
        {/* Preset buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          {ZOOM_PRESETS.map((preset) => {
            const isActive = Math.abs(range - preset.sec) <= preset.sec * 0.05;
            return (
              <button
                key={preset.label}
                onClick={() => { if (onZoomChange) onZoomChange(preset.sec); }}
                style={{
                  ...btnStyle,
                  flex: 1,
                  width: 'auto',
                  height: 20,
                  padding: '0 0',
                  fontSize: 11,
                  background: isActive ? '#1e3a5c' : '#1a1d27',
                  color: isActive ? '#90c8f0' : '#888',
                  border: `1px solid ${isActive ? '#3a6a9c' : '#333'}`,
                }}
                title={`Zoom to ${preset.label}`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Fine slider row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* − = zoom out = larger range = higher index */}
          <button
            style={{
              ...btnStyle,
              width: isMobile ? 36 : 28,
              height: isMobile ? 36 : 28,
              fontSize: isMobile ? 20 : 16,
            }}
            onClick={() => applyZoom(zoomIdx + 1)}
            disabled={zoomIdx >= ZOOM_STOPS.length - 1}
            title="Zoom out"
          >
            −
          </button>

          <input
            type="range"
            min={0}
            max={ZOOM_STOPS.length - 1}
            value={zoomIdx}
            onChange={(e) => applyZoom(Number(e.target.value))}
            style={{ flex: 1, accentColor: '#4a90d9', cursor: 'pointer' }}
          />

          {/* Label: current zoom stop */}
          <span
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              color: '#666',
              minWidth: 28,
              textAlign: 'right',
            }}
          >
            {ZOOM_STOP_LABELS[zoomIdx]}
          </span>

          {/* + = zoom in = smaller range = lower index */}
          <button
            style={{
              ...btnStyle,
              width: isMobile ? 36 : 28,
              height: isMobile ? 36 : 28,
              fontSize: isMobile ? 20 : 16,
            }}
            onClick={() => applyZoom(zoomIdx - 1)}
            disabled={zoomIdx <= 0}
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
