/**
 * SplitView — shows 2 or 4 cameras simultaneously, each with its own
 * timeline and video player. All cameras share the same time range.
 *
 * State model:
 *   - Per-camera: cursorTs, playbackTarget, previewFrames, timelineData
 *   - Shared:     rangeStart, rangeEnd, syncCursors toggle
 *
 * When syncCursors is on, seeking on any camera seeks all cameras to the
 * same timestamp.
 */

import { useState, useEffect, useCallback } from 'react';
import Timeline from './Timeline.jsx';
import VideoPlayer from './VideoPlayer.jsx';
import {
  fetchTimeline,
  fetchPreviewStrip,
  fetchPlaybackTarget,
  fetchSegmentInfo,
  requestPreviews,
} from '../utils/api.js';

function CameraPane({
  camera,
  rangeStart,
  rangeEnd,
  syncCursors,
  sharedCursorTs,
  onSharedSeek,
  onRangeChange,
}) {
  const [timelineData, setTimelineData] = useState(null);
  const [previewFrames, setPreviewFrames] = useState([]);
  const [cursorTs, setCursorTs] = useState(null);
  const [playbackTarget, setPlaybackTarget] = useState(null);
  const [error, setError] = useState(null);

  // Load timeline + previews when range changes
  useEffect(() => {
    if (!camera) return;
    let cancelled = false;

    async function load() {
      try {
        const [tl, strip] = await Promise.all([
          fetchTimeline(camera, rangeStart, rangeEnd),
          fetchPreviewStrip(camera, rangeStart, rangeEnd, 200),
        ]);
        if (cancelled) return;
        setTimelineData(tl);
        setPreviewFrames(strip.frames || []);
        requestPreviews(camera, rangeStart, rangeEnd).catch(() => {});
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [camera, rangeStart, rangeEnd]);

  const handleScrub = useCallback((ts) => {
    setCursorTs(ts);
  }, []);

  const handleSeek = useCallback(async (ts) => {
    setCursorTs(ts);
    if (syncCursors && onSharedSeek) {
      onSharedSeek(ts);
      return;
    }
    try {
      const target = await fetchPlaybackTarget(camera, ts);
      setPlaybackTarget(target);
    } catch (err) {
      setError(err.message);
    }
  }, [camera, syncCursors, onSharedSeek]);

  // When sync is on and shared cursor changes, seek this camera
  useEffect(() => {
    if (!syncCursors || sharedCursorTs == null || !camera) return;
    setCursorTs(sharedCursorTs);
    fetchPlaybackTarget(camera, sharedCursorTs)
      .then(setPlaybackTarget)
      .catch(() => {});
  }, [syncCursors, sharedCursorTs, camera]);

  const handleSegmentAdvance = useCallback(async (nextSegmentId) => {
    try {
      const info = await fetchSegmentInfo(nextSegmentId);
      const target = await fetchPlaybackTarget(camera, info.start_ts + 0.1);
      setPlaybackTarget(target);
    } catch {}
  }, [camera]);

  const handleTimeUpdate = useCallback((absoluteTs) => {
    setCursorTs(absoluteTs);
  }, []);

  const activeCursor = syncCursors ? (sharedCursorTs ?? cursorTs) : cursorTs;

  return (
    <div style={styles.pane}>
      <div style={styles.paneHeader}>
        <span style={styles.paneTitle}>{camera}</span>
        {error && <span style={styles.paneError}>{error}</span>}
      </div>

      <VideoPlayer
        playbackTarget={playbackTarget}
        camera={camera}
        onTimeUpdate={handleTimeUpdate}
        onSegmentAdvance={handleSegmentAdvance}
      />

      <div style={{ marginTop: 6 }}>
        <Timeline
          startTs={rangeStart}
          endTs={rangeEnd}
          segments={timelineData?.segments || []}
          gaps={timelineData?.gaps || []}
          events={timelineData?.events || []}
          activity={timelineData?.activity || []}
          frames={previewFrames}
          camera={camera}
          cursorTs={activeCursor}
          onScrub={handleScrub}
          onSeek={handleSeek}
          onRangeChange={onRangeChange}
        />
      </div>
    </div>
  );
}


export default function SplitView({ cameras, rangeStart, rangeEnd, onRangeChange }) {
  const [syncCursors, setSyncCursors] = useState(true);
  const [sharedCursorTs, setSharedCursorTs] = useState(null);

  const handleSharedSeek = useCallback((ts) => {
    setSharedCursorTs(ts);
  }, []);

  const count = cameras.length;
  const is2up = count === 2;
  const is4up = count >= 3;

  return (
    <div style={{ userSelect: 'none' }}>
      {/* Split view controls */}
      <div style={styles.controls}>
        <label style={styles.syncLabel}>
          <input
            type="checkbox"
            checked={syncCursors}
            onChange={(e) => setSyncCursors(e.target.checked)}
            style={{ marginRight: 5 }}
          />
          Sync all cameras
        </label>
        <span style={{ color: '#555', fontSize: 11 }}>
          {count}-camera split view
        </span>
      </div>

      {/* Grid layout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: is2up ? '1fr 1fr' : 'repeat(2, 1fr)',
          gap: 8,
        }}
      >
        {cameras.map((cam) => (
          <CameraPane
            key={cam}
            camera={cam}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            syncCursors={syncCursors}
            sharedCursorTs={sharedCursorTs}
            onSharedSeek={handleSharedSeek}
            onRangeChange={onRangeChange}
          />
        ))}
      </div>
    </div>
  );
}

const styles = {
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 8,
    padding: '6px 0',
  },
  syncLabel: {
    display: 'flex',
    alignItems: 'center',
    color: '#aaa',
    fontSize: 13,
    cursor: 'pointer',
  },
  pane: {
    background: '#0f1117',
    border: '1px solid #2a2d37',
    borderRadius: 6,
    overflow: 'hidden',
    minWidth: 0,
  },
  paneHeader: {
    background: '#13161f',
    padding: '5px 10px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid #2a2d37',
  },
  paneTitle: {
    color: '#aaa',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  paneError: {
    color: '#f44',
    fontSize: 11,
  },
};
