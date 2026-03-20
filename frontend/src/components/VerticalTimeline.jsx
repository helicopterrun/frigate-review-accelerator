/**
 * VerticalTimeline — Full-height vertical canvas timeline.
 *
 * Time flows top (startTs) → bottom (endTs).
 *
 * Horizontal zones (left to right):
 *   [0 … 58px]      — time tick labels (right-aligned, monospace 11px)
 *   [58px]           — 1px separator line
 *   [59 … w-18px]    — bar zone: segment bars, gap hatching, activity heatmap
 *   [w-18px … w]     — event color markers
 *
 * Drawing order (bottom layer → top):
 *   1.  Background
 *   2.  Vertical separator lines
 *   3.  Activity heatmap
 *   4.  Segment bars
 *   5.  Gap hatching
 *   6.  "Now" dashed line (current wall-clock time, if in range)
 *   7.  Time tick labels + horizontal hairlines across bar zone
 *   8.  Event markers (right strip)
 *   9.  Hover line (yellow, mouse position)
 *   10. Playback cursor (red, cursorTs) + timestamp badge
 *
 * Scroll: pans the time window forward/backward (15% per tick).
 * Zoom: controlled by −/slider/+ strip below the canvas.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { formatTimeShort, clampTs, nowTs } from '../utils/time.js';

function useDebounce(fn, delay) {
  const timer = useRef(null);
  return useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

const LABEL_WIDTH = 58;
const EVENT_WIDTH = 18;

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

/** Zoom-aware pan fraction: slower at fine zoom, faster at wide zoom. */
function panFraction(rangeSec) {
  if (rangeSec <= 1800)  return 0.05;  // ≤30m → precise (5%)
  if (rangeSec <= 3600)  return 0.08;  // ≤1h  → precise
  if (rangeSec <= 28800) return 0.12;  // ≤8h  → medium
  return 0.18;                          // >8h  → fast
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
  segments = [],
  gaps = [],
  events = [],
  activity = [],
  cursorTs,
  onScrub,
  onScrubEnd,
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

  const [dims, setDims] = useState({ w: 215, h: 600 });
  const [hoverY, setHoverY] = useState(null);

  const debouncedPreviewRequest = useDebounce(
    (ts) => { if (onPreviewRequest) onPreviewRequest(ts); },
    300
  );

  const range = endTs - startTs;

  // Derive zoom index from live range (no separate state — always in sync)
  const zoomIdx = nearestZoomIdx(range);

  const tsToY = useCallback(
    (ts) => ((ts - startTs) / range) * dims.h,
    [startTs, range, dims.h]
  );

  const yToTs = useCallback(
    (y) => clampTs(startTs + (y / dims.h) * range, startTs, endTs),
    [startTs, endTs, range, dims.h]
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

  // ── Canvas render ───────────────────────────────────────────────────────────
  useEffect(() => {
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

    // 1. Background
    ctx.fillStyle = '#090b10';
    ctx.fillRect(0, 0, LABEL_WIDTH, h);
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(LABEL_WIDTH, 0, w - LABEL_WIDTH, h);

    // 2. Separator lines
    ctx.fillStyle = '#1e2130';
    ctx.fillRect(LABEL_WIDTH, 0, 1, h);
    ctx.fillRect(barEnd, 0, 1, h);

    // 3. Activity heatmap — horizontal bands
    if (activity.length > 0) {
      const maxCount = Math.max(...activity.map((b) => b.count), 1);
      for (let i = 0; i < activity.length; i++) {
        const bucket = activity[i];
        if (bucket.count === 0) continue;
        const intensity = bucket.count / maxCount;
        const nextBucket = activity[i + 1];
        const bucketEnd = nextBucket ? nextBucket.bucket_ts : bucket.bucket_ts + 60;
        const y1 = Math.max(0, tsToY(bucket.bucket_ts));
        const y2 = Math.min(h, tsToY(bucketEnd));
        if (y2 <= y1) continue;
        ctx.fillStyle = `rgba(255,152,0,${0.07 + intensity * 0.30})`;
        ctx.fillRect(barStart, y1, barW, y2 - y1);
      }
    }

    // 4. Segment bars
    for (const seg of segments) {
      const y1 = Math.max(0, tsToY(seg.start_ts));
      const y2 = Math.min(h, tsToY(seg.end_ts));
      if (y2 <= y1) continue;
      ctx.fillStyle = seg.has_previews ? '#1e5a8a' : '#163d5c';
      ctx.fillRect(barStart, y1, barW, y2 - y1);
    }

    // 4b. Event density tinting — blend segment bars toward amber based on activity
    if (events.length > 0) {
      for (const seg of segments) {
        const segDur = seg.end_ts - seg.start_ts;
        if (segDur <= 0) continue;

        let coveredSec = 0;
        for (const evt of events) {
          const evtEnd = evt.end_ts ?? evt.start_ts + 5;
          const overlapStart = Math.max(seg.start_ts, evt.start_ts);
          const overlapEnd = Math.min(seg.end_ts, evtEnd);
          if (overlapEnd > overlapStart) coveredSec += overlapEnd - overlapStart;
        }

        const density = Math.min(1, coveredSec / Math.min(segDur, 300));
        if (density < 0.01) continue;

        const y1 = Math.max(0, tsToY(seg.start_ts));
        const y2 = Math.min(h, tsToY(seg.end_ts));
        if (y2 <= y1) continue;

        const r = Math.round(30 + density * 154);
        const g = Math.round(100 + density * 24);
        const b = Math.round(160 - density * 118);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.3 + density * 0.5})`;
        ctx.fillRect(barStart, y1, barW, y2 - y1);
      }
    }

    // 5. Gap hatching — fill + diagonal lines (clipped to each gap rect)
    for (const gap of gaps) {
      const y1 = Math.max(0, tsToY(gap.start_ts));
      const y2 = Math.min(h, tsToY(gap.end_ts));
      if (y2 - y1 < 2) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(barStart, y1, barW, y2 - y1);
      ctx.clip();

      ctx.fillStyle = 'rgba(35,12,12,0.75)';
      ctx.fillRect(barStart, y1, barW, y2 - y1);

      ctx.strokeStyle = 'rgba(200,50,50,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const spacing = 7;
      const extent = barW + (y2 - y1);
      for (let d = 0; d <= extent; d += spacing) {
        ctx.moveTo(barStart + d, y1);
        ctx.lineTo(barStart, y1 + d);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 6. "Now" dashed line (green, if wall-clock is within range)
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

    // 7. Time tick labels + horizontal hairlines across bar zone
    const TICK_INTERVALS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const MIN_TICK_SPACING_PX = 28;
    const maxTicks = Math.floor(h / MIN_TICK_SPACING_PX);
    const minIntervalSec = range / maxTicks;
    const tickSec = TICK_INTERVALS.find((t) => t >= minIntervalSec) ?? 86400;

    // Build per-tick-bucket event map for dots
    const LABEL_COLORS_MAP = {
      person: '#4CAF50', car: '#2196F3', dog: '#FF9800',
      cat: '#9C27B0', default: '#607D8B',
    };
    const tickBucketEvents = {};
    for (const evt of events) {
      const bucketTs = Math.floor(evt.start_ts / tickSec) * tickSec;
      if (!tickBucketEvents[bucketTs]) tickBucketEvents[bucketTs] = {};
      tickBucketEvents[bucketTs][evt.label] =
        (tickBucketEvents[bucketTs][evt.label] || 0) + 1;
    }

    const firstTick = Math.ceil(startTs / tickSec) * tickSec;
    for (let t = firstTick; t <= endTs; t += tickSec) {
      const y = tsToY(t);

      ctx.strokeStyle = '#1a1e2b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(barStart, y);
      ctx.lineTo(barEnd, y);
      ctx.stroke();

      ctx.fillStyle = '#4a4f65';
      ctx.font = '15px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatTimeShort(t), LABEL_WIDTH - 4, y);

      // Colored dot when events occurred in this tick bucket
      const bucketEvts = tickBucketEvents[t];
      if (bucketEvts) {
        const topLabel = Object.entries(bucketEvts)
          .sort((a, b) => b[1] - a[1])[0][0];
        const dotColor = LABEL_COLORS_MAP[topLabel] ?? LABEL_COLORS_MAP.default;
        ctx.beginPath();
        ctx.arc(LABEL_WIDTH - 18, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // 8. Event markers in right strip
    for (const evt of events) {
      const y1 = Math.max(0, tsToY(evt.start_ts));
      const y2 = Math.min(h, tsToY(evt.end_ts || evt.start_ts + 5));
      if (y2 <= y1) continue;
      ctx.fillStyle = EVENT_COLORS[evt.label] || EVENT_COLORS.default;
      ctx.fillRect(barEnd + 1, y1, EVENT_WIDTH - 1, Math.max(y2 - y1, 2));
    }

    // 9. Hover line (yellow, only when mouse is over canvas)
    if (hoverY !== null) {
      ctx.strokeStyle = 'rgba(255,220,80,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(barStart, hoverY);
      ctx.lineTo(barEnd, hoverY);
      ctx.stroke();
    }

    // 10. Playback cursor (red) fixed at vertical center + timestamp badge
    if (cursorTs != null) {
      const cy = h / 2; // cursor is always at center — timeline scrolls under it

      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(barStart, cy);
      ctx.lineTo(barEnd, cy);
      ctx.stroke();

      const label = formatTimeShort(cursorTs);
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const textW = ctx.measureText(label).width;
      const badgePad = 3;
      const badgeX = barStart + 4;
      const badgeY = Math.max(cy - 21, 0);

      ctx.fillStyle = 'rgba(20,10,10,0.85)';
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(badgeX - badgePad, badgeY, textW + badgePad * 2, 19);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ff8888';
      ctx.fillText(label, badgeX, badgeY + 3);
    }
  }, [dims, startTs, endTs, range, segments, gaps, events, activity, cursorTs, hoverY, tsToY]);

  // ── Scroll-to-pan: zoom-aware sensitivity + velocity acceleration ────────────
  // TODO: add unit tests for velocity calculation when frontend test harness is introduced
  const handleWheel = useCallback(
    (e) => {
      if (!onPan) return;
      e.preventDefault();

      const now = Date.now();
      // Keep only timestamps within the 200ms velocity window
      scrollTimestamps.current = scrollTimestamps.current.filter(t => now - t < 200);
      scrollTimestamps.current.push(now);

      const velocityFactor = scrollTimestamps.current.length / 3;
      const fraction = panFraction(range);
      const baseDelta = range * fraction;
      const effectiveDelta = baseDelta * (1 + Math.min(velocityFactor, 3));

      // deltaY < 0 = scroll up = go backward in time
      const delta = e.deltaY < 0 ? -effectiveDelta : effectiveDelta;
      onPan(delta);
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
      const ts = getTs(e);
      if (ts != null && onScrub) onScrub(ts);
    },
    [getTs, onScrub]
  );

  const handleMouseMove = useCallback(
    (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setHoverY(e.clientY - rect.top);
      const ts = getTs(e);
      if (ts != null && onScrub) onScrub(ts);
      if (ts != null) debouncedPreviewRequest(ts);
    },
    [getTs, onScrub, debouncedPreviewRequest]
  );

  const handleMouseUp = useCallback(
    (e) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const ts = getTs(e);
      if (ts != null && onSeek) onSeek(ts);
    },
    [getTs, onSeek]
  );

  const handleMouseLeave = useCallback(() => {
    isDragging.current = false;
    setHoverY(null);
    if (onScrubEnd) onScrubEnd();
  }, [onScrubEnd]);

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
            const fraction = -dx / dims.w * 0.5;
            const panAmount = range * fraction;
            onPan(panAmount);
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
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          flexShrink: 0,
          borderTop: '1px solid #1e2130',
          background: '#090b10',
        }}
      >
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
  );
}
