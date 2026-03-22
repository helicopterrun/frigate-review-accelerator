/**
 * Timeline — Canvas-based timeline with thumbnail scrubbing and scroll-to-zoom.
 *
 * ═══════════════════════════════════════════════════════════════
 * SCRUB BEHAVIOR CONTRACT
 * ═══════════════════════════════════════════════════════════════
 *
 * HOVER  → cursor line + timestamp badge only. No preview fetch.
 * DRAG   → swap preview image. Call onScrub(ts). No video decode.
 * RELEASE/CLICK → call onSeek(ts). Only moment video decode starts.
 *
 * SCROLL → zoom time range centred on cursor position.
 *   Scroll up   → zoom in (min 15 minutes)
 *   Scroll down → zoom out (max 7 days)
 *   Range stays in App.jsx — Timeline calls onRangeChange(newStart, newEnd).
 *
 * ═══════════════════════════════════════════════════════════════
 *
 * Canvas layers (bottom to top):
 *   1. Background
 *   2. Activity heatmap
 *   3. Segment bars (blue)
 *   4. Gap hatching (diagonal lines, dark red)
 *   5. Event markers
 *   6. Time tick labels
 *   7. Cursor line (red)
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { formatTimeShort, clampTs } from '../utils/time.js';

const TIMELINE_HEIGHT = 100;
const HEATMAP_Y = 0;
const HEATMAP_HEIGHT = 16;
const LABEL_Y = 18;
const LABEL_HEIGHT = 16;
const SEGMENT_Y = 36;
const SEGMENT_HEIGHT = 28;
const EVENT_Y = 66;
const EVENT_HEIGHT = 14;
const CURSOR_COLOR = '#ff4444';

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
  default:    '#607D8B',
};

// ─── Icon map: same set as VerticalTimeline (keep in sync) ──────────────────
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

const _tlRedrawCallbacks = new Set();
let _tlIconsLoaded = 0;
const _TL_ICON_TARGET = Object.keys(ICON_PATHS).length;

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
    _tlIconsLoaded++;
    if (_tlIconsLoaded >= _TL_ICON_TARGET) {
      for (const cb of _tlRedrawCallbacks) cb();
    }
  };
  return oc;
}

const ICON_CACHE = new Map();
for (const [label, pathData] of Object.entries(ICON_PATHS)) {
  ICON_CACHE.set(label, buildIconCanvas(pathData, EVENT_COLORS[label] ?? EVENT_COLORS.default, 12));
}

const DRAG_THRESHOLD_PX = 3;

// Zoom constraints
const MIN_RANGE_SEC = 15 * 60;       // 15 minutes
const MAX_RANGE_SEC = 7 * 24 * 3600; // 7 days
const ZOOM_FACTOR = 0.25;            // 25% zoom per scroll tick

/**
 * Preload and cache preview images in memory.
 */
function useImageCache(frames) {
  const cacheRef = useRef(new Map());

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const cache = cacheRef.current;
    const activeUrls = new Set(frames.map((f) => f.url));

    for (const frame of frames) {
      if (!cache.has(frame.url)) {
        const img = new Image();
        img.src = frame.url;
        cache.set(frame.url, img);
      }
    }

    for (const key of cache.keys()) {
      if (!activeUrls.has(key)) {
        cache.delete(key);
      }
    }
  }, [frames]);

  return cacheRef;
}

/**
 * Binary search for nearest frame — O(log n).
 */
function findNearestFrame(frames, ts) {
  if (!frames || frames.length === 0) return null;
  if (frames.length === 1) return frames[0];

  let lo = 0;
  let hi = frames.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].ts <= ts) lo = mid;
    else hi = mid;
  }

  return Math.abs(frames[lo].ts - ts) <= Math.abs(frames[hi].ts - ts)
    ? frames[lo]
    : frames[hi];
}


export default function Timeline({
  startTs,
  endTs,
  segments = [],
  gaps = [],
  events = [],
  activity = [],
  frames = [],
  camera,
  cursorTs,
  onScrub,
  onSeek,
  onRangeChange,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTs, setHoverTs] = useState(null);
  const [scrubTs, setScrubTs] = useState(null);
  const [mouseDownX, setMouseDownX] = useState(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [, _forceIconRedraw] = useState(0);
  const imageCacheRef = useImageCache(frames);

  // Register for icon-load completion so event icons appear on first render
  // (SVG→Image is async; without this, icons are blank until next redraw).
  useEffect(() => {
    const notify = () => _forceIconRedraw(v => v + 1);
    _tlRedrawCallbacks.add(notify);
    return () => { _tlRedrawCallbacks.delete(notify); };
  }, []);

  const range = endTs - startTs;

  const tsToX = useCallback(
    (ts) => ((ts - startTs) / range) * containerWidth,
    [startTs, range, containerWidth]
  );
  const xToTs = useCallback(
    (x) => startTs + (x / containerWidth) * range,
    [startTs, range, containerWidth]
  );

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ───────────────────────────────────────────────
  // Scroll-to-zoom
  // ───────────────────────────────────────────────
  const handleWheel = useCallback(
    (e) => {
      if (!onRangeChange) return;
      e.preventDefault();

      // Determine zoom cursor position
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const cursorFrac = Math.max(0, Math.min(1, x / containerWidth));
      const pivotTs = startTs + cursorFrac * range;

      // Zoom direction: negative deltaY = scroll up = zoom in
      const zoomIn = e.deltaY < 0;
      const factor = zoomIn ? (1 - ZOOM_FACTOR) : (1 + ZOOM_FACTOR);
      const newRange = Math.min(MAX_RANGE_SEC, Math.max(MIN_RANGE_SEC, range * factor));

      // Keep the pivot timestamp at the same screen fraction
      const newStart = pivotTs - cursorFrac * newRange;
      const newEnd = pivotTs + (1 - cursorFrac) * newRange;

      onRangeChange(newStart, newEnd);
    },
    [startTs, range, containerWidth, onRangeChange]
  );

  // Attach wheel listener with { passive: false } so preventDefault works
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ───────────────────────────────────────────────
  // Canvas render
  // ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerWidth * dpr;
    canvas.height = TIMELINE_HEIGHT * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${TIMELINE_HEIGHT}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 1. Background
    ctx.fillStyle = '#1a1d27';
    ctx.fillRect(0, 0, containerWidth, TIMELINE_HEIGHT);

    // 2. Activity heatmap
    if (activity.length > 0) {
      const maxCount = Math.max(...activity.map((b) => b.count), 1);
      for (const bucket of activity) {
        if (bucket.count === 0) continue;
        const intensity = bucket.count / maxCount;
        const nextBucketTs = activity.find((b) => b.bucket_ts > bucket.bucket_ts);
        const bucketEnd = nextBucketTs
          ? nextBucketTs.bucket_ts
          : bucket.bucket_ts + 60;
        const x1 = Math.max(0, tsToX(bucket.bucket_ts));
        const x2 = Math.min(containerWidth, tsToX(bucketEnd));
        if (x2 <= x1) continue;
        ctx.fillStyle = `rgba(255, 152, 0, ${0.15 + intensity * 0.55})`;
        ctx.fillRect(x1, HEATMAP_Y, x2 - x1, HEATMAP_HEIGHT);
      }
    }

    // 3. Segment bars
    ctx.fillStyle = '#1e5a8a';
    for (const seg of segments) {
      const x1 = Math.max(0, tsToX(seg.start_ts));
      const x2 = Math.min(containerWidth, tsToX(seg.end_ts));
      if (x2 > x1) {
        ctx.fillRect(x1, SEGMENT_Y, x2 - x1, SEGMENT_HEIGHT);
      }
    }

    // 4. Gap hatching
    ctx.save();
    for (const gap of gaps) {
      const x1 = Math.max(0, tsToX(gap.start_ts));
      const x2 = Math.min(containerWidth, tsToX(gap.end_ts));
      if (x2 - x1 < 2) continue;

      ctx.fillStyle = 'rgba(50, 20, 20, 0.6)';
      ctx.fillRect(x1, SEGMENT_Y, x2 - x1, SEGMENT_HEIGHT);

      ctx.strokeStyle = 'rgba(255, 60, 60, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let hx = x1; hx < x2; hx += 8) {
        ctx.moveTo(hx, SEGMENT_Y);
        ctx.lineTo(hx + SEGMENT_HEIGHT, SEGMENT_Y + SEGMENT_HEIGHT);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 5. Event markers — colored bar + 12px icon when bar is wide enough.
    // Unlisted labels have no ICON_CACHE entry and get bar-only rendering.
    for (const evt of events) {
      const x1 = Math.max(0, tsToX(evt.start_ts));
      const x2 = Math.min(
        containerWidth,
        tsToX(evt.end_ts || evt.start_ts + 5)
      );
      const barW = Math.max(x2 - x1, 3);
      ctx.fillStyle = EVENT_COLORS[evt.label] || EVENT_COLORS.default;
      ctx.fillRect(x1, EVENT_Y, barW, EVENT_HEIGHT);
      if (barW >= 14) {
        const iconCanvas = ICON_CACHE.get(evt.label);
        if (iconCanvas) {
          const iconX = x1 + Math.floor((barW - 12) / 2);
          const iconY = EVENT_Y + Math.floor((EVENT_HEIGHT - 12) / 2);
          ctx.drawImage(iconCanvas, iconX, iconY, 12, 12);
        }
      }
    }

    // 6. Time labels
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    let tickSec;
    if (range <= 3600) tickSec = 300;
    else if (range <= 14400) tickSec = 900;
    else if (range <= 43200) tickSec = 1800;
    else tickSec = 3600;

    const firstTick = Math.ceil(startTs / tickSec) * tickSec;
    for (let t = firstTick; t <= endTs; t += tickSec) {
      const x = tsToX(t);
      ctx.fillText(formatTimeShort(t), x, LABEL_Y + 12);
      ctx.strokeStyle = '#2a2d37';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, LABEL_Y + LABEL_HEIGHT);
      ctx.lineTo(x, TIMELINE_HEIGHT);
      ctx.stroke();
    }

    // 7. Cursor line
    const activeTs = scrubTs ?? hoverTs ?? cursorTs;
    if (activeTs != null) {
      const cx = tsToX(activeTs);
      ctx.strokeStyle = CURSOR_COLOR;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, TIMELINE_HEIGHT);
      ctx.stroke();
    }
  }, [
    containerWidth, startTs, endTs, range, segments, gaps, events,
    activity, cursorTs, hoverTs, scrubTs, tsToX,
  ]);

  // ───────────────────────────────────────────────
  // Mouse handlers
  // ───────────────────────────────────────────────
  const getTimestamp = useCallback(
    (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = e.clientX - rect.left;
      return clampTs(xToTs(x), startTs, endTs);
    },
    [xToTs, startTs, endTs]
  );

  const handleMouseDown = useCallback(
    (e) => {
      setIsDragging(true);
      setMouseDownX(e.clientX);
      const ts = getTimestamp(e);
      if (ts != null) {
        setScrubTs(ts);
        if (onScrub) onScrub(ts);
      }
    },
    [getTimestamp, onScrub]
  );

  const handleMouseMove = useCallback(
    (e) => {
      const ts = getTimestamp(e);
      if (ts == null) return;

      if (isDragging) {
        setScrubTs(ts);
        if (onScrub) onScrub(ts);
      } else {
        setHoverTs(ts);
      }
    },
    [isDragging, getTimestamp, onScrub]
  );

  const handleMouseUp = useCallback(
    (e) => {
      if (!isDragging) return;

      const ts = getTimestamp(e);

      setIsDragging(false);
      setScrubTs(null);
      setMouseDownX(null);

      if (ts != null && onSeek) {
        onSeek(ts);
      }
    },
    [isDragging, mouseDownX, getTimestamp, onSeek]
  );

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
    setScrubTs(null);
    setHoverTs(null);
    setMouseDownX(null);
  }, []);

  // ───────────────────────────────────────────────
  // Preview image for current scrub position
  // ───────────────────────────────────────────────
  const displayTs = scrubTs ?? hoverTs ?? cursorTs;
  const nearestFrame = displayTs != null ? findNearestFrame(frames, displayTs) : null;
  const previewUrl = (camera && displayTs != null)
    ? `/api/preview/${camera}/${displayTs}`
    : nearestFrame?.url ?? null;

  const showPreview = scrubTs != null || cursorTs != null;

  // Last successfully loaded preview URL — stays visible until the next
  // frame is ready. Avoids the black flash caused by unmounting the old
  // <img> before the new one has loaded.
  const [displayedUrl, setDisplayedUrl] = useState(null);
  const loadingImgRef = useRef(null);

  useEffect(() => {
    if (!previewUrl) return;

    if (loadingImgRef.current) {
      loadingImgRef.current.onload = null;
      loadingImgRef.current.onerror = null;
      loadingImgRef.current = null;
    }

    const img = new Image();
    loadingImgRef.current = img;

    img.onload = () => {
      setDisplayedUrl(previewUrl);
      loadingImgRef.current = null;
    };
    img.onerror = () => {
      // Do not update displayedUrl — keep the last good frame visible
      // rather than going blank when a frame has not been generated yet.
      loadingImgRef.current = null;
    };

    img.src = previewUrl;

    return () => {
      // Cancel on cleanup (rapid scrubbing or unmount)
      img.onload = null;
      img.onerror = null;
    };
  }, [previewUrl]);

  return (
    <div ref={containerRef} style={{ width: '100%', userSelect: 'none' }}>
      {/* Preview thumbnail */}
      <div
        style={{
          height: showPreview ? 180 : 0,
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: showPreview ? 4 : 0,
          borderRadius: 4,
          overflow: 'hidden',
          position: 'relative',
          transition: 'height 0.15s ease',
        }}
      >
        {showPreview && displayedUrl ? (
          <img
            src={displayedUrl}
            alt="Preview"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : null}
        {showPreview && displayTs != null && (
          <div
            style={{
              position: 'absolute',
              bottom: 4,
              right: 8,
              background: 'rgba(0,0,0,0.8)',
              color: '#fff',
              padding: '2px 8px',
              borderRadius: 3,
              fontSize: 12,
              fontFamily: 'monospace',
            }}
          >
            {formatTimeShort(displayTs)}
          </div>
        )}
      </div>

      {/* Hover timestamp */}
      {!isDragging && hoverTs != null && (
        <div
          style={{
            textAlign: 'center',
            color: '#888',
            fontSize: 11,
            fontFamily: 'monospace',
            marginBottom: 2,
            height: 14,
          }}
        >
          {formatTimeShort(hoverTs)}
        </div>
      )}

      {/* Canvas timeline */}
      <canvas
        ref={canvasRef}
        style={{ cursor: 'crosshair', display: 'block', borderRadius: 4 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        title="Scroll to zoom · drag to scrub · click to seek"
      />

      {onRangeChange && (
        <div style={{ textAlign: 'right', color: '#333', fontSize: 10, marginTop: 2 }}>
          scroll to zoom
        </div>
      )}
    </div>
  );
}
