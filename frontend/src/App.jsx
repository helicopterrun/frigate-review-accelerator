/**
 * App — Main application shell.
 *
 * v2 additions:
 *   - onSegmentAdvance: fetches /api/playback for next segment → fixes cursor drift
 *   - Timeline zoom: scroll-wheel zooms range, clamped to 15m–7d
 *   - Split view: select 2+ cameras → SplitView component
 */

import { useState, useEffect, useCallback } from 'react';
import CameraSelector from './components/CameraSelector.jsx';
import Timeline from './components/Timeline.jsx';
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
} from './utils/api.js';
import { todayStartTs, nowTs, formatDateTime } from './utils/time.js';

const MIN_RANGE_SEC = 15 * 60;
const MAX_RANGE_SEC = 7 * 24 * 3600;

export default function App() {
  const [cameras, setCameras] = useState([]);
  // Single-camera mode state
  const [selectedCamera, setSelectedCamera] = useState(null);
  // Multi-camera (split view) state
  const [selectedCameras, setSelectedCameras] = useState([]);
  const [multiMode, setMultiMode] = useState(false);

  const [timelineData, setTimelineData] = useState(null);
  const [previewFrames, setPreviewFrames] = useState([]);
  const [cursorTs, setCursorTs] = useState(null);
  const [playbackTarget, setPlaybackTarget] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [rangeStart, setRangeStart] = useState(todayStartTs());
  const [rangeEnd, setRangeEnd] = useState(nowTs());

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

  // ─── Range change (from zoom or presets) ───
  const handleRangeChange = useCallback((newStart, newEnd) => {
    const newRange = newEnd - newStart;
    if (newRange < MIN_RANGE_SEC || newRange > MAX_RANGE_SEC) return;
    setRangeStart(newStart);
    setRangeEnd(newEnd);
  }, []);

  // ─── Scrub handler: images only, no video ───
  const handleScrub = useCallback((ts) => {
    setCursorTs(ts);
  }, []);

  // ─── Seek handler: calls /api/playback, triggers video ───
  const handleSeek = useCallback(
    async (ts) => {
      if (!selectedCamera) return;
      setCursorTs(ts);

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
  // Called by VideoPlayer when a segment ends and it auto-advances.
  // We fetch the new PlaybackTarget so segment_start_ts stays accurate.
  const handleSegmentAdvance = useCallback(
    async (nextSegmentId) => {
      if (!selectedCamera) return;
      try {
        // Fetch playback at the very start of the next segment (offset 0)
        const nextStreamUrl = `/api/segment/${nextSegmentId}/stream`;
        // We need the segment's start_ts to compute cursor position correctly.
        // The cleanest path is to call /api/playback with the next segment's start_ts.
        // Since we don't have it here, derive it from current playbackTarget.end_ts.
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
    setPlaybackTarget(null);
    setTimelineData(null);
    setPreviewFrames([]);
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
      <div style={styles.header}>
        <h1 style={styles.title}>Frigate Review Accelerator</h1>
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
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Controls */}
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

        <div style={styles.rangeButtons}>
          {[1, 4, 8, 24].map((h) => (
            <button key={h} onClick={() => setRange(h)} style={styles.rangeBtn}>
              {h}h
            </button>
          ))}
        </div>

        {cursorTs && !multiMode && (
          <span style={styles.timestamp}>{formatDateTime(cursorTs)}</span>
        )}
      </div>

      {/* Main content: split view or single view */}
      {multiMode && selectedCameras.length >= 2 ? (
        <SplitView
          cameras={selectedCameras}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onRangeChange={handleRangeChange}
        />
      ) : (
        <>
          <VideoPlayer
            playbackTarget={playbackTarget}
            camera={selectedCamera}
            onTimeUpdate={handlePlaybackTimeUpdate}
            onSegmentAdvance={handleSegmentAdvance}
          />

          <div style={{ marginTop: 12 }}>
            <Timeline
              startTs={rangeStart}
              endTs={rangeEnd}
              segments={timelineData?.segments || []}
              gaps={timelineData?.gaps || []}
              events={timelineData?.events || []}
              activity={timelineData?.activity || []}
              frames={previewFrames}
              cursorTs={cursorTs}
              onScrub={handleScrub}
              onSeek={handleSeek}
              onRangeChange={handleRangeChange}
            />
          </div>

          {timelineData && (
            <div style={styles.coverage}>
              {timelineData.segments.length} segments ·{' '}
              {timelineData.gaps.length} gaps ·{' '}
              {timelineData.coverage_pct.toFixed(1)}% coverage ·{' '}
              {timelineData.events.length} events
            </div>
          )}
        </>
      )}

      {multiMode && selectedCameras.length < 2 && (
        <div style={styles.splitHint}>
          Select 2–4 cameras above to enable split view.
        </div>
      )}

      <AdminPanel />
    </div>
  );
}

const styles = {
  container: { maxWidth: 1200, margin: '0 auto', padding: '16px 24px' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    borderBottom: '1px solid #2a2d37',
    paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: 600, color: '#e0e0e0' },
  healthBadge: { fontSize: 12, color: '#888', display: 'flex', alignItems: 'center' },
  error: {
    background: '#3a1515',
    border: '1px solid #5a2020',
    color: '#f88',
    padding: '8px 12px',
    borderRadius: 4,
    marginBottom: 12,
    fontSize: 13,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  rangeButtons: { display: 'flex', gap: 4 },
  rangeBtn: {
    background: '#1a1d27',
    border: '1px solid #333',
    color: '#aaa',
    padding: '4px 12px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
  },
  timestamp: {
    color: '#4CAF50',
    fontSize: 13,
    fontFamily: 'monospace',
    marginLeft: 'auto',
  },
  coverage: {
    textAlign: 'center',
    color: '#666',
    fontSize: 12,
    marginTop: 8,
    paddingBottom: 24,
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
