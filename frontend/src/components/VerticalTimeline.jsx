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
import { formatTimeShort, formatTime, clampTs, nowTs } from '../utils/time.js';
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
  { label: '1d',  sec: 24 * 3600 },
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
  person:     '#4CAF50',
  car:        '#2196F3',
  truck:      '#1565C0',
  motorcycle: '#E91E63',
  bicycle:    '#00BCD4',
  dog:        '#FF9800',
  cat:        '#9C27B0',
  bird:       '#8BC34A',
  horse:      '#795548',
  bear:       '#607D8B',
  deer:       '#A1887F',
  package:    '#FFC107',
  default:    '#ffcc00',
};

// ─── Icon map: Lucide SVG elements keyed by Frigate label ───────────────────
// Unlisted labels ("face", "fire", "license_plate", etc.) silently produce no
// icon — no text fallback, no placeholder, no console warning.
// TODO: add frontend test — ICON_CACHE populated at module init,
// unknown labels ("face", "fire", "license_plate") produce no icon
// and no console warning.
const ICON_PATHS = {
  person:     `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  car:        `<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>`,
  truck:      `<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>`,
  motorcycle: `<path d="m18 14-1-3"/><path d="m3 9 6 2a2 2 0 0 1 2-2h2a2 2 0 0 1 1.99 1.81"/><path d="M8 17h3a1 1 0 0 0 1-1 6 6 0 0 1 6-6 1 1 0 0 0 1-1v-.75A5 5 0 0 0 17 5"/><circle cx="19" cy="17" r="3"/><circle cx="5" cy="17" r="3"/>`,
  bicycle:    `<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>`,
  dog:        `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  cat:        `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  bird:       `<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/>`,
  horse:      `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  bear:       `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  deer:       `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  package:    `<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>`,
};

// Pre-render each (label, color) into an offscreen 12×12 canvas.
// Async SVG→Image load; canvas is blank until onload fires. After all icons
// load, any registered drawCanvas callbacks are fired for a final repaint.
const _vtRedrawCallbacks = new Set();
let _vtIconsLoaded = 0;
const _VT_ICON_TARGET = Object.keys(ICON_PATHS).length;

function buildIconCanvas(svgPathData, color, size = 12) {
  const oc = document.createElement('canvas');
  oc.width = size;
  oc.height = size;
  const ctx = oc.getContext('2d');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPathData}</svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    _vtIconsLoaded++;
    if (_vtIconsLoaded >= _VT_ICON_TARGET) {
      for (const cb of _vtRedrawCallbacks) cb();
    }
  };
  return oc;
}

const ICON_CACHE = new Map();
for (const [label, pathData] of Object.entries(ICON_PATHS)) {
  ICON_CACHE.set(label, buildIconCanvas(pathData, EVENT_COLORS[label] ?? EVENT_COLORS.default, 12));
}

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
  timeFormat = '12h',
  onPreloadHint = null,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const isDragging = useRef(false);
  const touchStartRef = useRef(null);
  const scrollVelocityRef = useRef(0);
  const scrollRafRef      = useRef(null);

  // Animation refs — no state to avoid per-frame re-renders
  // TODO: verify animation ref doesn't leak — must cancel on unmount and on new click during active animation
  const displayCursorRef = useRef(cursorTs);    // what the canvas currently displays
  const animRef = useRef(null);                 // { from, to, startTime, rafId } | null
  const drawCanvasRef = useRef(null);           // always points to latest draw fn
  const drawReticleOnlyRef = useRef(null);      // always points to latest drawReticleOnly fn
  const canvasSnapshotRef = useRef(null);       // ImageData snapshot saved after layer 8, before reticle

  // TODO: add frontend test — scrubVelocityRef < 0.5 for 120ms fires
  // onPreloadHint only when isDragging.current is true (not on hover).
  // lastPreloadTsRef prevents spam: hint only fires when |ts - last| > 2s.
  const scrubLastYRef = useRef(null);    // { y: number, time: number }
  const scrubVelocityRef = useRef(0);    // px/ms
  const scrubIdleTimerRef = useRef(null);
  const lastPreloadTsRef = useRef(null); // spam suppression

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

    // willReadFrequently: true — required because drawReticleOnly uses
    // getImageData/putImageData on every cursorTs change (~60fps during autoplay).
    // Without this flag the browser emits a performance warning and may
    // GPU-round-trip on every readback.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.scale(dpr, dpr);

    const barStart = LABEL_WIDTH + 1;
    const barEnd = w - EVENT_WIDTH;
    const barW = barEnd - barStart;
    const reticleY = h * RETICLE_FRACTION;

    // Local spp for y → ts direction in density precomputation.
    // Same value as secondsPerPixel — computed locally to avoid extra dep.
    const spp = h > 0 ? (endTs - startTs) / h : 1;

    // Tick interval — hoisted so step 9 (lock moment) can reference it.
    const TICK_INTERVALS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const MIN_TICK_SPACING_PX = 32;
    const _maxTicks = Math.floor(h / MIN_TICK_SPACING_PX);
    const _minIntervalSec = (endTs - startTs) / _maxTicks;
    const tickSec = TICK_INTERVALS.find((t) => t >= _minIntervalSec) ?? 86400;

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
    // tickSec is hoisted above step 1 so step 9 (lock moment) can reference it.

    // TODO: unit test —
    //   FADE_START=48, FADE_END=14 — label fades over ~34px window
    //   tickPhase=0.0 (on tick)  → distToTickPx=0  → reticleAlpha=0.97
    //   tickPhase=0.5 (midpoint) → distToTickPx=max → reticleAlpha=0.88
    //   no Math.round in lock moment — stays continuous at all positions
    //   ctx.globalAlpha === 1.0 after every loop iteration

    const firstTick = Math.ceil(startTs / tickSec) * tickSec;
    for (let t = firstTick; t <= endTs; t += tickSec) {
      const y = tsToY(t);

      // ── Hairline ── always drawn at correct y, never faded
      ctx.strokeStyle = 'rgba(26, 30, 43, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(barStart, y);
      ctx.lineTo(barEnd, y);
      ctx.stroke();

      // ── Label fade near reticle ──
      // fadeFactor drives ALL opacity near the reticle.
      // Do NOT multiply by a second opacity curve — double-fading
      // causes labels to vanish too early and creates uneven density.
      const dist = Math.abs(y - reticleY);
      const FADE_START = 48;
      const FADE_END   = 14;
      const fadeFactor = Math.max(0, Math.min(1,
        dist > FADE_START ? 1
        : dist < FADE_END  ? 0
        : (dist - FADE_END) / (FADE_START - FADE_END)
      ));

      if (fadeFactor <= 0) continue;  // hairline already drawn above

      // Uniform font and color for all ticks — the reticle handles emphasis.
      // A font-weight or color shift here would compete with the reticle signal.
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(74, 79, 101, 1.0)';

      ctx.globalAlpha = fadeFactor;   // fadeFactor is the sole opacity driver
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatTimeShort(t, timeFormat), LABEL_WIDTH - 4, y);
      ctx.globalAlpha = 1.0;          // ALWAYS reset immediately
    }

    // 7. Layer 2: Detection ticks with proximity-aware labels
    // Ticks span 60% of bar zone width (centered). Opacity rises near reticle.
    // Labels only near reticle (±60px), with 14px collision avoidance.
    //
    // Z-ORDER INVARIANT: must render AFTER grid/hairlines (step 6) and
    // BEFORE density overlay (future step). Event markers are primary
    // signal and must remain visible regardless of other layers.
    //
    // INDEPENDENCE INVARIANT: this layer must NEVER depend on densityData,
    // preview state, or autoplay state. If events disappear, it is a data
    // or wiring bug — do not suppress them here.
    //
    // TODO: extract _labelCollisionFilter(events, reticleY, tsToY) for unit testing.
    // TODO: add frontend test — labels render for all visible events, not just ±60px of reticle.
    const tickBarStart = barStart + barW * 0.1;
    const tickBarEnd   = barStart + barW * 0.9;

    // Pass 1: collect all visible events with their canvas y position.
    // Two-tier opacity: full brightness within 60px of reticle, dim beyond.
    let renderedEventCount = 0;
    // TODO: test warnedLabels dedup — unknown label warns exactly once per
    // drawCanvas call regardless of how many events share that label
    const warnedLabels = new Set();
    const visibleEvents = [];
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    for (const evt of events) {
      // Timestamp field guard: Frigate events use start_ts in the local
      // DB schema (event_sync.py maps start_time → start_ts). If a future
      // schema change breaks this, the fallback chain prevents silent
      // failures and the warning below will fire.
      const ts = evt.start_ts ?? evt.start_time ?? evt.timestamp;
      if (ts == null) continue;

      const y = tsToY(ts);
      if (y < -10 || y > h + 10) continue;

      renderedEventCount++;
      const distFromReticle = Math.abs(y - reticleY);
      const color = EVENT_COLORS[evt.label] || EVENT_COLORS.default;

      if (!EVENT_COLORS[evt.label] && !warnedLabels.has(evt.label)) {
        // Log unknown labels — helps catch label casing mismatches
        // (e.g. "person:face" or "Person"). Fires once per unknown label
        // per drawCanvas call to avoid console spam at 60fps.
        console.warn('[VerticalTimeline] Unknown event label:', evt.label);
        warnedLabels.add(evt.label);
      }

      ctx.globalAlpha = distFromReticle <= 60 ? 1.0 : 0.75;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(tickBarStart, y);
      ctx.lineTo(tickBarEnd, y);
      ctx.stroke();

      visibleEvents.push({ evt, y, distFromReticle });
    }
    ctx.globalAlpha = 1.0;

    if (events.length > 0 && renderedEventCount === 0) {
      console.warn('[VerticalTimeline] Events present but not visible', {
        eventCount: events.length,
        startTs,
        endTs,
        minEventTs: Math.min(...events.map(e => e.start_ts ?? e.start_time ?? 0)),
        maxEventTs: Math.max(...events.map(e => e.start_ts ?? e.start_time ?? 0)),
      });
    }

    // Pass 2: icons across full canvas — closest to reticle wins each slot.
    // Two-tier opacity: ≤60px → 1.0 (prominent), >60px → 0.45 (dim but readable).
    // Collision avoidance: 14px minimum y-spacing; closest event wins on conflict.
    // Unlisted labels (face, fire, license_plate, etc.) have no ICON_CACHE entry
    // and are silently skipped — no icon, no slot reservation, no warning.
    // Draw order: icons after ticks (this pass runs after the tick loop above).
    visibleEvents.sort((a, b) => a.distFromReticle - b.distFromReticle);
    const labeledYs = [];
    for (const { evt, y, distFromReticle } of visibleEvents) {
      const iconCanvas = ICON_CACHE.get(evt.label);
      if (!iconCanvas) continue; // label not in ICON_PATHS — silent skip
      if (labeledYs.some((ly) => Math.abs(y - ly) < 14)) continue;
      labeledYs.push(y);
      ctx.globalAlpha = distFromReticle <= 60 ? 1.0 : 0.45;
      ctx.drawImage(iconCanvas, LABEL_WIDTH - 16, y - 6, 12, 12);
    }
    ctx.globalAlpha = 1.0;

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

    // Save snapshot of canvas after all data layers, before the reticle.
    // drawReticleOnly() uses this to restore and redraw only the reticle,
    // avoiding the full O(h) density gradient pass on every cursorTs change.
    canvasSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);

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

      // COORDINATE SYSTEM INVARIANT
      // reticle_time = displayCursorRef.current = cursorTs from App.jsx
      // reticle_y    = h * RETICLE_FRACTION (never moves)
      //
      // Strong form: when a tick timestamp t equals cursor_time,
      //   tsToY(t) === reticleY  (within floating point tolerance)
      //   tick label and reticle label represent the same instant
      //
      // Violation of this means tsToY and the reticle Y are out of sync —
      // fix the coordinate system, do not patch the rendering.
      //
      // Future enhancement (NOT in this PR): consider slightly increasing
      // label brightness or weight within ~40px of reticle for a "focus
      // zone" effect. Must be purely visual — no position changes.

      // Reticle reads the passing scale — no box, no border, no background.
      // Font weight 600 (more controlled than bold) + system monospace stack
      // for clean rendering across platforms.
      // Math.round(reticleY) + 0.5: pixel-aligns the baseline regardless of
      // devicePixelRatio, preventing sub-pixel blur on non-retina displays.
      //
      // Invariant: this label MUST equal what a tick at cursor_time would
      // show. When tsToY(cursor_time) === reticleY, both values are the same
      // timestamp — any divergence indicates a coordinate system bug.
      const label = formatTime(displayTs, timeFormat);
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Distance from cursor to nearest tick, computed in screen space
      // using tick phase — no timestamp rounding, no coordinate divergence.
      // tickPhase is 0 at a tick and 0.5 halfway between ticks.
      // distPx is the pixel distance to the nearest tick line.
      const tickPhase = (displayTs % tickSec) / tickSec;        // 0..1
      const distToTickPx = Math.min(tickPhase, 1 - tickPhase)   // 0..0.5
                           * (tickSec / spp);                    // → pixels

      // Raise alpha slightly (<8px) for a "locked on tick" feel.
      // Fully continuous — no snapping, no jump at tick midpoint.
      const reticleAlpha = distToTickPx < 8 ? 0.97 : 0.88;

      ctx.fillStyle = `rgba(190, 225, 250, ${reticleAlpha})`;
      ctx.fillText(label, barStart + barW / 2, Math.round(reticleY) + 0.5);
    }
  }, [dims, startTs, endTs, gaps, events, densityData, activeLabels, autoplayState, tsToY, timeFormat]);
  // Note: cursorTs is NOT a dep — read from displayCursorRef at draw time.

  // Keep drawCanvasRef pointing to the latest version of drawCanvas.
  // The rAF animation loop calls drawCanvasRef.current() so it always uses
  // current props even if the component re-rendered mid-animation.
  useEffect(() => { drawCanvasRef.current = drawCanvas; }, [drawCanvas]);

  // Trigger canvas redraw whenever draw deps change (data, layout, hover).
  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  // Register drawCanvas for the icon-load completion callback so icons are
  // visible on first page load (SVG→Image load is async; without this, icons
  // appear blank until the next user-triggered redraw).
  useEffect(() => {
    _vtRedrawCallbacks.add(drawCanvas);
    return () => { _vtRedrawCallbacks.delete(drawCanvas); };
  }, [drawCanvas]);

  /** Reticle-only redraw — restores the pre-reticle snapshot and draws only layer 9.
   *  Called on every cursorTs change during autoplay (~60fps) to avoid the full
   *  O(h * density_buckets) density gradient pass.  Falls back to drawCanvas when
   *  no snapshot is available (first render, after a resize, etc.). */
  const drawReticleOnly = useCallback(() => {
    const canvas = canvasRef.current;
    const snapshot = canvasSnapshotRef.current;
    if (!canvas || !snapshot) {
      drawCanvasRef.current?.();
      return;
    }

    const { w, h } = dims;
    const dpr = window.devicePixelRatio || 1;

    // If dims changed since snapshot was saved, fall back to full redraw.
    if (snapshot.width !== w * dpr || snapshot.height !== h * dpr) {
      drawCanvasRef.current?.();
      return;
    }

    // willReadFrequently: true — required because drawReticleOnly uses
    // getImageData/putImageData on every cursorTs change (~60fps during autoplay).
    // Without this flag the browser emits a performance warning and may
    // GPU-round-trip on every readback.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // putImageData writes at physical pixel coords — reset transform first.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(snapshot, 0, 0);
    // Re-apply DPR scale for all subsequent drawing (logical CSS pixels).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const barStart = LABEL_WIDTH + 1;
    const barEnd = w - EVENT_WIDTH;
    const barW = barEnd - barStart;
    const reticleY = h * RETICLE_FRACTION;
    const spp = h > 0 ? (endTs - startTs) / h : 1;

    const TICK_INTERVALS_LOCAL = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const MIN_TICK_SPACING_PX = 32;
    const _maxTicks = Math.floor(h / MIN_TICK_SPACING_PX);
    const _minIntervalSec = h > 0 ? (endTs - startTs) / _maxTicks : 1;
    const tickSec = TICK_INTERVALS_LOCAL.find((t) => t >= _minIntervalSec) ?? 86400;

    const displayTs = displayCursorRef.current;
    if (displayTs != null) {
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

      ctx.strokeStyle = 'rgba(100, 180, 220, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(barStart, reticleY - 10);
      ctx.lineTo(barEnd, reticleY - 10);
      ctx.moveTo(barStart, reticleY + 10);
      ctx.lineTo(barEnd, reticleY + 10);
      ctx.stroke();

      const label = formatTime(displayTs, timeFormat);
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const tickPhase = (displayTs % tickSec) / tickSec;
      const distToTickPx = Math.min(tickPhase, 1 - tickPhase) * (tickSec / spp);
      const reticleAlpha = distToTickPx < 8 ? 0.97 : 0.88;

      ctx.fillStyle = `rgba(190, 225, 250, ${reticleAlpha})`;
      ctx.fillText(label, barStart + barW / 2, Math.round(reticleY) + 0.5);
    }
  }, [dims, startTs, endTs, autoplayState, timeFormat]);

  useEffect(() => { drawReticleOnlyRef.current = drawReticleOnly; }, [drawReticleOnly]);

  // TODO: test drawReticleOnly is called (not drawCanvas) during
  // autoplay — verify canvas snapshot is saved after step 8 and
  // restored correctly on rapid cursorTs updates
  // Sync displayCursorRef from cursorTs prop when no animation is running,
  // then immediately redraw so cursor position stays current during playback.
  useEffect(() => {
    if (!animRef.current) {
      displayCursorRef.current = cursorTs;
      drawReticleOnlyRef.current?.();
    }
  }, [cursorTs]);

  // Cancel any in-flight animation on unmount.
  useEffect(() => {
    return () => {
      if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);
    };
  }, []);

  useEffect(() => {
    return () => { clearTimeout(scrubIdleTimerRef.current); };
  }, []);

  // ── Scroll-to-pan: inertial physics with velocity + damping ─────────────────
  const decayScroll = useCallback(() => {
    const DAMPING  = 0.88;
    // 0.008 ≈ 0.5/60: frame-time normalized deadzone.
    // Sub-pixel at all zoom levels — no jitter, no premature stop.
    const DEADZONE = secondsPerPixel * 0.008;

    scrollVelocityRef.current *= DAMPING;

    if (Math.abs(scrollVelocityRef.current) < DEADZONE) {
      scrollVelocityRef.current = 0;
      scrollRafRef.current = null;
      return;
    }

    onPan(scrollVelocityRef.current);
    scrollRafRef.current = requestAnimationFrame(decayScroll);
  }, [onPan, secondsPerPixel]);

  const handleWheel = useCallback(
    (e) => {
      if (!onPan) return;
      e.preventDefault();

      // Cancel in-flight decay so new input never stacks onto a glide.
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }

      // Clamp to 40: normalizes trackpad micro-events and mouse wheel.
      const normalizedDelta =
        Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 40);

      // K=0.22: zoom-aware sensitivity. Same gesture = same screen
      // fraction regardless of zoom level. Tune ±0.05 if needed.
      const K = 0.22;
      const sensitivity = secondsPerPixel * K;

      scrollVelocityRef.current += normalizedDelta * sensitivity;

      // Impulse BEFORE clamp: first frame reflects raw intent.
      onPan(scrollVelocityRef.current);

      // Clamp for decay stability only — not felt on frame 1.
      // range*0.15: consistent cap across zoom levels, no teleport.
      const maxV = (endTs - startTs) * 0.15;
      scrollVelocityRef.current = Math.max(
        -maxV,
        Math.min(maxV, scrollVelocityRef.current)
      );

      scrollRafRef.current = requestAnimationFrame(decayScroll);
    },
    [onPan, secondsPerPixel, endTs, startTs, decayScroll]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
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

  const handleMouseMove = useCallback((e) => {
    const ts = getTs(e);
    if (ts != null) debouncedPreviewRequest(ts);

    // Scrub velocity tracking — mouse interaction path only.
    // This is NOT the scroll/pan velocity system (scrollVelocityRef).
    // Do not merge these — they serve different purposes.
    const now = performance.now();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const currentY = e.clientY - rect.top;
      if (scrubLastYRef.current !== null) {
        const dt = now - scrubLastYRef.current.time;
        if (dt > 0) {
          const dy = Math.abs(currentY - scrubLastYRef.current.y);
          scrubVelocityRef.current = dy / dt;
        }
      }
      scrubLastYRef.current = { y: currentY, time: now };
    }

    // Intent detection: low velocity + actively dragging → fire preload hint.
    // Spam guard: only hint if ts has moved more than 2 seconds from the
    // last hint position, preventing repeated churn on slow movement.
    if (
      isDragging.current &&
      scrubVelocityRef.current < 0.5 &&
      ts != null &&
      onPreloadHint
    ) {
      clearTimeout(scrubIdleTimerRef.current);
      scrubIdleTimerRef.current = setTimeout(() => {
        if (
          lastPreloadTsRef.current === null ||
          Math.abs(lastPreloadTsRef.current - ts) > 2
        ) {
          lastPreloadTsRef.current = ts;
          onPreloadHint(ts);
        }
      }, 120);
    }
  }, [getTs, debouncedPreviewRequest, onPreloadHint]);

  // Click = recenter with 250ms ease-out animation.
  // Animation uses refs + rAF — no setState per frame.
  // The animation starts from the current displayCursorRef value (which may
  // itself be mid-animation if user clicks again before it finishes).
  const handleMouseUp = useCallback(
    (e) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      scrubLastYRef.current = null;
      scrubVelocityRef.current = 0;
      clearTimeout(scrubIdleTimerRef.current);

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
    scrollVelocityRef.current = 0;
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    isDragging.current = false;
    scrubLastYRef.current = null;
    scrubVelocityRef.current = 0;
    clearTimeout(scrubIdleTimerRef.current);
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
          scrollVelocityRef.current = 0;
          if (scrollRafRef.current) {
            cancelAnimationFrame(scrollRafRef.current);
            scrollRafRef.current = null;
          }
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
