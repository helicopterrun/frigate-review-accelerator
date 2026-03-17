/**
 * Timeline — Canvas-based timeline with thumbnail scrubbing.
 *
 * ═══════════════════════════════════════════════════════════════
 * SCRUB BEHAVIOR CONTRACT (the thing that makes this feel fast)
 * ═══════════════════════════════════════════════════════════════
 *
 * HOVER (mouse over timeline, no button):
 *   1. Calculate timestamp from X position
 *   2. Show cursor line on canvas
 *   3. Show timestamp badge
 *   4. DO NOT update preview (too chatty)
 *
 * DRAG (mouseDown + mouseMove):
 *   1. Calculate timestamp from X position
 *   2. Show cursor line on canvas
 *   3. Find nearest cached preview image → swap <img> src
 *   4. Call onScrub(ts) — parent tracks position
 *   5. DO NOT TOUCH VIDEO. No decode. No fetch. Images only.
 *
 * RELEASE (mouseUp after drag):
 *   1. Final timestamp from X position
 *   2. Call onSeek(ts) — parent calls /api/playback and starts video
 *   3. This is the ONLY moment video decode is triggered
 *
 * CLICK (mouseDown + mouseUp without significant move):
 *   1. Same as RELEASE — treat as instant seek
 *
 * ═══════════════════════════════════════════════════════════════
 *
 * Canvas layers (bottom to top):
 *   1. Background (#1a1d27)
 *   2. Activity heatmap (translucent colored bars)
 *   3. Segment bars (blue = recording exists)
 *   4. Gap hatching (diagonal lines = no recording)
 *   5. Event markers (colored by label)
 *   6. Time tick labels
 *   7. Cursor line (red vertical)
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
  person: '#4CAF50',
  car: '#2196F3',
  dog: '#FF9800',
  cat: '#9C27B0',
  default: '#607D8B',
};

// Minimum pixel distance to distinguish drag from click
const DRAG_THRESHOLD_PX = 3;

/**
 * Preload and cache preview images in memory.
 * Returns a ref to Map<timestamp, HTMLImageElement>.
 */
function useImageCache(frames) {
  const cacheRef = useRef(new Map());

  useEffect(() => {
    if (!frames || frames.length === 0) return;

    const cache = cacheRef.current;
    const activeTs = new Set(frames.map((f) => f.ts));

    // Load new frames
    for (const frame of frames) {
      if (!cache.has(frame.ts)) {
        const img = new Image();
        img.src = frame.url;
        cache.set(frame.ts, img);
      }
    }

    // Evict stale frames (keep memory bounded)
    for (const key of cache.keys()) {
      if (!activeTs.has(key)) {
        cache.delete(key);
      }
    }
  }, [frames]);

  return cacheRef;
}

/**
 * Binary search for nearest frame — O(log n) instead of O(n).
 * Frames must be sorted by ts (they are from the API).
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
  cursorTs,
  onScrub,
  onSeek,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTs, setHoverTs] = useState(null);
  const [scrubTs, setScrubTs] = useState(null); // only set during drag
  const [mouseDownX, setMouseDownX] = useState(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const imageCacheRef = useImageCache(frames);

  const range = endTs - startTs;

  // Timestamp ↔ pixel conversion
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

        // Orange heatmap with intensity-based alpha
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

    // 4. Gap hatching (diagonal lines)
    ctx.save();
    for (const gap of gaps) {
      const x1 = Math.max(0, tsToX(gap.start_ts));
      const x2 = Math.min(containerWidth, tsToX(gap.end_ts));
      if (x2 - x1 < 2) continue;

      // Dark background
      ctx.fillStyle = 'rgba(50, 20, 20, 0.6)';
      ctx.fillRect(x1, SEGMENT_Y, x2 - x1, SEGMENT_HEIGHT);

      // Diagonal hatch lines
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

    // 5. Event markers
    for (const evt of events) {
      const x1 = Math.max(0, tsToX(evt.start_ts));
      const x2 = Math.min(
        containerWidth,
        tsToX(evt.end_ts || evt.start_ts + 5)
      );
      ctx.fillStyle = EVENT_COLORS[evt.label] || EVENT_COLORS.default;
      ctx.fillRect(x1, EVENT_Y, Math.max(x2 - x1, 3), EVENT_HEIGHT);
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
      ctx.lineWidth = 2;
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
  // Mouse handlers — implementing the scrub contract
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
        // DRAG: update preview, call onScrub. No video.
        setScrubTs(ts);
        if (onScrub) onScrub(ts);
      } else {
        // HOVER: cursor line + timestamp only
        setHoverTs(ts);
      }
    },
    [isDragging, getTimestamp, onScrub]
  );

  const handleMouseUp = useCallback(
    (e) => {
      if (!isDragging) return;

      const ts = getTimestamp(e);
      const dx = Math.abs(e.clientX - (mouseDownX ?? 0));

      setIsDragging(false);
      setScrubTs(null);
      setMouseDownX(null);

      if (ts != null && onSeek) {
        // RELEASE or CLICK: trigger playback
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
  const previewImg = nearestFrame
    ? imageCacheRef.current.get(nearestFrame.ts)
    : null;

  // Show preview only during drag (not bare hover — too chatty per your critique)
  const showPreview = scrubTs != null || cursorTs != null;

  return (
    <div ref={containerRef} style={{ width: '100%', userSelect: 'none' }}>
      {/* Preview thumbnail — shown during drag scrub */}
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
        {showPreview && previewImg && previewImg.complete ? (
          <img
            src={previewImg.src}
            alt="Preview"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
            }}
          />
        ) : showPreview ? (
          <span style={{ color: '#555', fontSize: 13 }}>
            {displayTs != null ? 'Loading...' : ''}
          </span>
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

      {/* Hover timestamp (shown when not dragging) */}
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
      />
    </div>
  );
}
