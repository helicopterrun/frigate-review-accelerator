/**
 * App — Main application shell.
 *
 * Data flow (v2):
 *   1. /api/cameras → CameraSelector
 *   2. /api/timeline → Timeline (segments, gaps, events, activity)
 *   3. /api/preview-strip → Timeline (frames for image cache)
 *   4. Timeline.onScrub → update cursor (images only, no video)
 *   5. Timeline.onSeek → /api/playback → PlaybackTarget → VideoPlayer
 *   6. VideoPlayer.onTimeUpdate → cursor follows playback position
 *
 * Key invariant: video decode ONLY happens in step 5/6.
 * Steps 1-4 are pure image + metadata operations.
 *
 * v3 additions:
 *   - POST /api/preview/request on camera/range change (on-demand hint)
 *   - Health badge shows "pending" instead of "generating" (accurate label)
 */

import { useState, useEffect, useCallback } from 'react';
import CameraSelector from './components/CameraSelector.jsx';
import Timeline from './components/Timeline.jsx';
import VideoPlayer from './components/VideoPlayer.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import {
  fetchCameras,
  fetchTimeline,
  fetchPreviewStrip,
  fetchPlaybackTarget,
  fetchHealth,
  requestPreviews,
} from './utils/api.js';
import { todayStartTs, nowTs, formatDateTime } from './utils/time.js';

export default function App() {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [timelineData, setTimelineData] = useState(null);
  const [previewFrames, setPreviewFrames] = useState([]);
  const [cursorTs, setCursorTs] = useState(null);
  const [playbackTarget, setPlaybackTarget] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [rangeStart, setRangeStart] = useState(todayStartTs);
  const [rangeEnd, setRangeEnd] = useState(nowTs);

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

  // ─── Load timeline + previews when camera/range changes ───
  useEffect(() => {
    if (!selectedCamera) return;
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

        // Signal the backend to prioritize this viewport for preview generation.
        // Fire-and-forget — we don't await or surface errors from this.
        // The worker will drain the queue next cycle (within scan_interval_sec).
        requestPreviews(selectedCamera, rangeStart, rangeEnd).catch(() => {});

      } catch (err) {
        if (!cancelled) setError(`Timeline load failed: ${err.message}`);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [selectedCamera, rangeStart, rangeEnd]);

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

  // ─── Playback time tracking: cursor follows video position ───
  const handlePlaybackTimeUpdate = useCallback((absoluteTs) => {
    setCursorTs(absoluteTs);
  }, []);

  // ─── Camera switch: reset everything ───
  const handleCameraChange = useCallback((name) => {
    setSelectedCamera(name);
    setCursorTs(null);
    setPlaybackTarget(null);
    setTimelineData(null);
    setPreviewFrames([]);
  }, []);

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
              // "pending" is accurate — the worker processes these in priority
              // order (recency-first), not all at once.
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
        <CameraSelector
          cameras={cameras}
          selected={selectedCamera}
          onSelect={handleCameraChange}
        />

        <div style={styles.rangeButtons}>
          {[1, 4, 8, 24].map((h) => (
            <button key={h} onClick={() => setRange(h)} style={styles.rangeBtn}>
              {h}h
            </button>
          ))}
        </div>

        {cursorTs && (
          <span style={styles.timestamp}>{formatDateTime(cursorTs)}</span>
        )}
      </div>

      {/* Video player */}
      <VideoPlayer
        playbackTarget={playbackTarget}
        camera={selectedCamera}
        onTimeUpdate={handlePlaybackTimeUpdate}
      />

      {/* Timeline */}
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
        />
      </div>

      {/* Coverage info */}
      {timelineData && (
        <div style={styles.coverage}>
          {timelineData.segments.length} segments ·{' '}
          {timelineData.gaps.length} gaps ·{' '}
          {timelineData.coverage_pct.toFixed(1)}% coverage ·{' '}
          {timelineData.events.length} events
        </div>
      )}

      {/* Ops panel — fixed bottom-right, always available */}
      <AdminPanel />
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 1200,
    margin: '0 auto',
    padding: '16px 24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    borderBottom: '1px solid #2a2d37',
    paddingBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    color: '#e0e0e0',
  },
  healthBadge: {
    fontSize: 12,
    color: '#888',
    display: 'flex',
    alignItems: 'center',
  },
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
    gap: 16,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  rangeButtons: {
    display: 'flex',
    gap: 4,
  },
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
  loading: {
    color: '#888',
    textAlign: 'center',
    paddingTop: 100,
    fontSize: 16,
  },
};
