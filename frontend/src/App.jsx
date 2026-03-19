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

import { useState, useEffect, useCallback, useMemo } from 'react';

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
  fetchTimeline,
  fetchPreviewStrip,
  fetchPlaybackTarget,
  fetchHealth,
  requestPreviews,
  eventSnapshotUrl,
} from './utils/api.js';
import { todayStartTs, nowTs, formatDateTime, formatTime } from './utils/time.js';

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

function LabelFilterPills({ availableLabels, activeLabels, onToggle, onToggleAll, isMobile }) {
  if (!availableLabels?.length) return null;
  const allActive = activeLabels === null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '4px 0', alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#555', marginRight: 2, flexShrink: 0 }}>
        Filter:
      </span>
      <button
        onClick={onToggleAll}
        style={{
          padding: '3px 9px', borderRadius: 12,
          border: `1px solid ${allActive ? '#aaa' : '#333'}`,
          background: allActive ? '#2a2d37' : 'transparent',
          color: allActive ? '#e0e0e0' : '#555',
          fontSize: isMobile ? 13 : 11,
          cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
        }}
      >all</button>
      {availableLabels.map(label => {
        const color = LABEL_COLORS[label] ?? LABEL_COLORS.default;
        const isActive = activeLabels === null || activeLabels.has(label);
        return (
          <button key={label} onClick={() => onToggle(label)} style={{
            padding: '3px 9px', borderRadius: 12,
            border: `1px solid ${isActive ? color : '#333'}`,
            background: isActive ? `${color}22` : 'transparent',
            color: isActive ? color : '#555',
            fontSize: isMobile ? 13 : 11,
            cursor: 'pointer', fontFamily: 'monospace',
            display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isActive ? color : '#555',
              display: 'inline-block', flexShrink: 0,
            }}/>
            {label}
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
  const [previewFrames, setPreviewFrames] = useState([]);
  const [cursorTs, setCursorTs] = useState(null);
  const [hoverTs, setHoverTs] = useState(null);
  const [playbackTarget, setPlaybackTarget] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [rangeStart, setRangeStart] = useState(todayStartTs());
  const [rangeEnd, setRangeEnd] = useState(nowTs());

  const [gotoValue, setGotoValue] = useState(() => toDatetimeLocal(nowTs()));

  // Escape key closes ops drawer
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setOpsOpen(false); };
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

  // Label filter state — persisted to localStorage, null means "all"
  const [activeLabels, setActiveLabels] = useState(() => {
    try {
      const stored = localStorage.getItem('frigate-active-labels');
      return stored ? new Set(JSON.parse(stored)) : null;
    } catch { return null; }
  });

  // Event snapshot state (from prev/next navigation)
  const [activeEventSnapshot, setActiveEventSnapshot] = useState(null);

  // ─── Init: load cameras + health ───
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [cams, hp] = await Promise.all([fetchCameras(), fetchHealth()]);
        if (cancelled) return;

        setCameras(cams);
        setHealth(hp);
        if (cams.length > 0 && !selectedCamera) {
          setSelectedCamera(cams[0].name);
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

  // ─── Derived label lists ───
  const availableLabels = useMemo(() => {
    if (!timelineData?.events?.length) return [];
    return [...new Set(timelineData.events.map(e => e.label))].sort();
  }, [timelineData]);

  const filteredEvents = useMemo(() => {
    if (!timelineData?.events) return [];
    if (activeLabels === null) return timelineData.events;
    return timelineData.events.filter(e => activeLabels.has(e.label));
  }, [timelineData, activeLabels]);

  // ─── Range change (from zoom or presets) ───
  const handleRangeChange = useCallback((newStart, newEnd) => {
    const newRange = newEnd - newStart;
    if (newRange < MIN_RANGE_SEC || newRange > MAX_RANGE_SEC) return;
    setRangeStart(newStart);
    setRangeEnd(newEnd);
  }, []);

  // ─── Scrub handler: sets hover position + moves cursor line ───
  // Snaps to nearest covered segment so preview and cursor never land in a gap.
  const handleScrub = useCallback((ts) => {
    const snapped = snapToCoverage(ts, timelineData?.segments);
    setHoverTs(snapped);
    setCursorTs(snapped);
  }, [timelineData]);

  // ─── Scrub end: clear hover (cursor stays at last position) ───
  const handleScrubEnd = useCallback(() => {
    setHoverTs(null);
  }, []);

  // ─── Seek handler: commits playback, clears hover + snapshot ───
  const handleSeek = useCallback(
    async (ts) => {
      if (!selectedCamera) return;
      setHoverTs(null);
      setCursorTs(ts);
      setActiveEventSnapshot(null);

      try {
        const target = await fetchPlaybackTarget(selectedCamera, ts);
        setPlaybackTarget(target);
        setError(null);
      } catch (err) {
        setError(`Playback failed: ${err.message}`);
      }
    },
    [selectedCamera]
  );

  // ─── Segment advance: fixes cursor drift bug ───
  const handleSegmentAdvance = useCallback(
    async (nextSegmentId) => {
      if (!selectedCamera) return;
      try {
        const nextTs = playbackTarget?.segment_end_ts ?? (cursorTs ?? 0);
        const target = await fetchPlaybackTarget(selectedCamera, nextTs + 0.1);
        setPlaybackTarget(target);
      } catch {}
    },
    [selectedCamera, playbackTarget, cursorTs]
  );

  // ─── Playback time tracking ───
  const handlePlaybackTimeUpdate = useCallback((absoluteTs) => {
    setCursorTs(absoluteTs);
  }, []);

  // ─── Camera switch ───
  const handleCameraChange = useCallback((name) => {
    setSelectedCamera(name);
    setCursorTs(null);
    setHoverTs(null);
    setPlaybackTarget(null);
    setTimelineData(null);
    setPreviewFrames([]);
    setActiveEventSnapshot(null);
  }, []);

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

  // ─── Range presets ───
  const setRange = useCallback((hours) => {
    const end = nowTs();
    setRangeStart(end - hours * 3600);
    setRangeEnd(end);
  }, []);

  // ─── "Go to" handler ───
  const handleGoto = useCallback(() => {
    if (!gotoValue) return;
    const ts = new Date(gotoValue).getTime() / 1000;
    if (isNaN(ts)) return;
    const halfRange = (rangeEnd - rangeStart) / 2;
    handleRangeChange(ts - halfRange, ts + halfRange);
    handleSeek(ts);
  }, [gotoValue, rangeStart, rangeEnd, handleRangeChange, handleSeek]);

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
    if (!filteredEvents.length) return;
    const sorted = [...filteredEvents].sort((a, b) => a.start_ts - b.start_ts);
    const current = cursorTs ?? 0;

    let target;
    if (direction === 'next') {
      target = sorted.find(e => e.start_ts > current + 1) ?? sorted[0];
    } else {
      target = [...sorted].reverse().find(e => e.start_ts < current - 1)
               ?? sorted[sorted.length - 1];
    }

    if (!target) return;

    setCursorTs(target.start_ts);
    try {
      const playTarget = await fetchPlaybackTarget(selectedCamera, target.start_ts);
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

    // Re-center range if event is outside current view
    if (target.start_ts < rangeStart || target.start_ts > rangeEnd) {
      const halfRange = (rangeEnd - rangeStart) / 2;
      handleRangeChange(target.start_ts - halfRange, target.start_ts + halfRange);
    }
  }, [filteredEvents, cursorTs, selectedCamera, rangeStart, rangeEnd, handleRangeChange]);

  // ─── Derive scrub preview URL ───
  const activePreviewUrl =
    hoverTs != null && selectedCamera
      ? `/api/preview/${selectedCamera}/${hoverTs}`
      : null;

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

      {/* Controls */}
      {isMobile ? (
        <div style={{ flexShrink: 0, marginBottom: 8 }}>
          {/* Row 1: Camera + Split */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            {!multiMode ? (
              <div style={{ flex: 1, minWidth: 0 }}>
                <CameraSelector
                  cameras={cameras}
                  selected={selectedCamera}
                  onSelect={handleCameraChange}
                  isMobile={true}
                />
              </div>
            ) : (
              <div style={{ flex: 1, minWidth: 0 }}>
                <CameraSelector
                  cameras={cameras}
                  selectedMany={selectedCameras}
                  onSelectMany={handleSelectMany}
                  multiMode={true}
                  maxSelect={4}
                  isMobile={true}
                />
              </div>
            )}
            <button
              onClick={handleToggleMultiMode}
              style={{
                ...styles.rangeBtn,
                borderColor: multiMode ? '#2196F3' : '#333',
                color: multiMode ? '#2196F3' : '#aaa',
                padding: '10px 16px',
                fontSize: '15px',
                minHeight: 44,
                flexShrink: 0,
              }}
            >
              {multiMode ? '◈ Single' : '◈ Split'}
            </button>
          </div>
          {/* Row 2: Range presets + Go group */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', overflowX: 'auto' }}>
            {[1, 4, 8, 24].map((h) => (
              <button key={h} onClick={() => setRange(h)} style={{
                ...styles.rangeBtn,
                padding: '10px 16px',
                fontSize: '15px',
                minHeight: 44,
                flexShrink: 0,
              }}>
                {h}h
              </button>
            ))}
            {!multiMode && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <input
                  type="datetime-local"
                  value={gotoValue}
                  onChange={(e) => setGotoValue(e.target.value)}
                  style={{
                    colorScheme: 'dark',
                    background: '#1a1d27',
                    border: '1px solid #333',
                    color: '#aaa',
                    padding: '3px 6px',
                    borderRadius: 4,
                    fontSize: 16,
                  }}
                />
                <button onClick={handleGoto} style={{
                  ...styles.rangeBtn,
                  padding: '10px 16px',
                  fontSize: '15px',
                  minHeight: 44,
                  flexShrink: 0,
                }}>
                  Go
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={styles.controls}>
          {!multiMode ? (
            <CameraSelector
              cameras={cameras}
              selected={selectedCamera}
              onSelect={handleCameraChange}
            />
          ) : (
            <CameraSelector
              cameras={cameras}
              selectedMany={selectedCameras}
              onSelectMany={handleSelectMany}
              multiMode={true}
              maxSelect={4}
            />
          )}

          <button
            onClick={handleToggleMultiMode}
            style={{
              ...styles.rangeBtn,
              borderColor: multiMode ? '#2196F3' : '#333',
              color: multiMode ? '#2196F3' : '#aaa',
            }}
          >
            {multiMode ? '◈ Single' : '◈ Split'}
          </button>

          {/* "Go to" group — single-camera mode only */}
          {!multiMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#666', fontSize: 16 }}>Go to:</span>
              <input
                type="datetime-local"
                value={gotoValue}
                onChange={(e) => setGotoValue(e.target.value)}
                style={{
                  colorScheme: 'dark',
                  background: '#1a1d27',
                  border: '1px solid #333',
                  color: '#aaa',
                  padding: '3px 6px',
                  borderRadius: 4,
                  fontSize: 16,
                }}
              />
              <button onClick={handleGoto} style={styles.rangeBtn}>
                Go
              </button>
            </div>
          )}

          <div style={styles.rangeButtons}>
            {[1, 4, 8, 24].map((h) => (
              <button key={h} onClick={() => setRange(h)} style={styles.rangeBtn}>
                {h}h
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Label filter pills (single-camera mode only) */}
      {!multiMode && (
        <LabelFilterPills
          availableLabels={availableLabels}
          activeLabels={activeLabels}
          onToggle={toggleLabel}
          onToggleAll={toggleAllLabels}
          isMobile={isMobile}
        />
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
                segments={timelineData?.segments || []}
                gaps={timelineData?.gaps || []}
                events={filteredEvents}
                activity={timelineData?.activity || []}
                cursorTs={cursorTs}
                onScrub={handleScrub}
                onScrubEnd={handleScrubEnd}
                onSeek={handleSeek}
                onRangeChange={handleRangeChange}
                isMobile={isMobile}
                onPreviewRequest={(ts) => {
                  const halfWindow = 5 * 60;
                  requestPreviews(selectedCamera, ts - halfWindow, ts + halfWindow).catch(() => {});
                }}
              />
            </div>

            {/* Prev/Next event navigation */}
            {filteredEvents.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                borderTop: '1px solid #1e2130',
                flexShrink: 0,
              }}>
                <button onClick={() => navigateEvent('prev')} style={styles.navBtn}>
                  ‹ prev
                </button>
                <span style={{ fontSize: 10, color: '#444', fontFamily: 'monospace' }}>
                  {filteredEvents.length} evt
                </span>
                <button onClick={() => navigateEvent('next')} style={styles.navBtn}>
                  next ›
                </button>
              </div>
            )}

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
  navBtn: {
    background: '#1a1d27',
    border: '1px solid #333',
    color: '#aaa',
    padding: '4px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
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
