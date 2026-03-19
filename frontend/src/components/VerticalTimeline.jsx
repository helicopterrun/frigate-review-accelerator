/**
 * VerticalTimeline — Full-height vertical canvas timeline.
 *
 * Time flows top (startTs) → bottom (endTs).
 *
 * Horizontal zones (left to right):
 *   [0 … 50px]      — time tick labels (right-aligned, monospace 10px)
 *   [50px]           — 1px separator line
 *   [51 … w-18px]    — bar zone: segment bars, gap hatching, activity heatmap
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
 *   11. Footer "scroll to zoom"
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { formatTimeShort, clampTs, nowTs } from '../utils/time.js';

const LABEL_WIDTH = 50;
const EVENT_WIDTH = 18;
const MIN_RANGE_SEC = 15 * 60;        // 15 minutes
const MAX_RANGE_SEC = 7 * 24 * 3600;  // 7 days
const ZOOM_FACTOR = 0.25;             // 25% per scroll tick

const EVENT_COLORS = {
  person: '#4CAF50',
  car: '#2196F3',
  dog: '#FF9800',
  cat: '#9C27B0',
  default: '#607D8B',
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
  onRangeChange,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const isDragging = useRef(false);

  const [dims, setDims] = useState({ w: 190, h: 600 });
  const [hoverY, setHoverY] = useState(null);

  const range = endTs - startTs;

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
    const el = containerRef.current;
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
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const barStart = LABEL_WIDTH + 1;  // x where bar zone begins
    const barEnd = w - EVENT_WIDTH;    // x where bar zone ends
    const barW = barEnd - barStart;

    // 1. Background
    ctx.fillStyle = '#090b10';
    ctx.fillRect(0, 0, LABEL_WIDTH, h);
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(LABEL_WIDTH, 0, w - LABEL_WIDTH, h);

    // 2. Separator lines
    ctx.fillStyle = '#1e2130';
    ctx.fillRect(LABEL_WIDTH, 0, 1, h);
    ctx.fillStyle = '#1e2130';
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
      // Diagonal lines at 45°, sweeping across the gap rect
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
    let tickSec;
    if (range <= 3600) tickSec = 300;
    else if (range <= 14400) tickSec = 900;
    else if (range <= 43200) tickSec = 1800;
    else tickSec = 3600;

    const firstTick = Math.ceil(startTs / tickSec) * tickSec;
    for (let t = firstTick; t <= endTs; t += tickSec) {
      const y = tsToY(t);

      // Hairline across bar zone
      ctx.strokeStyle = '#1a1e2b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(barStart, y);
      ctx.lineTo(barEnd, y);
      ctx.stroke();

      // Label (right-aligned in label column)
      ctx.fillStyle = '#4a4f65';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatTimeShort(t), LABEL_WIDTH - 4, y);
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

    // 10. Playback cursor (red) + floating timestamp badge
    if (cursorTs != null) {
      const cy = tsToY(cursorTs);

      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barStart, cy);
      ctx.lineTo(barEnd, cy);
      ctx.stroke();

      // Timestamp badge
      const label = formatTimeShort(cursorTs);
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const textW = ctx.measureText(label).width;
      const badgePad = 3;
      const badgeX = barStart + 4;
      const badgeY = Math.max(cy - 16, 0);

      ctx.fillStyle = 'rgba(20,10,10,0.85)';
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(badgeX - badgePad, badgeY, textW + badgePad * 2, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ff8888';
      ctx.fillText(label, badgeX, badgeY + 2);
    }

    // 11. Footer "scroll to zoom"
    ctx.font = '9px monospace';
    ctx.fillStyle = '#2a2d37';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('scroll to zoom', w / 2, h - 2);
  }, [dims, startTs, endTs, range, segments, gaps, events, activity, cursorTs, hoverY, tsToY]);

  // ── Scroll-to-zoom ──────────────────────────────────────────────────────────
  const handleWheel = useCallback(
    (e) => {
      if (!onRangeChange) return;
      e.preventDefault();

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const y = e.clientY - rect.top;
      const fraction = Math.max(0, Math.min(1, y / dims.h));
      const pivotTs = startTs + fraction * range;

      const zoomIn = e.deltaY < 0;
      const factor = zoomIn ? (1 - ZOOM_FACTOR) : (1 + ZOOM_FACTOR);
      const newRange = Math.min(MAX_RANGE_SEC, Math.max(MIN_RANGE_SEC, range * factor));

      const newStart = pivotTs - fraction * newRange;
      const newEnd = pivotTs + (1 - fraction) * newRange;

      onRangeChange(newStart, newEnd);
    },
    [startTs, range, dims.h, onRangeChange]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

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
    },
    [getTs, onScrub]
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
      style={{ width: '100%', height: '100%', userSelect: 'none', position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        style={{ cursor: 'crosshair', display: 'block' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}
