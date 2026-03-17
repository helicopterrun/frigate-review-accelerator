/**
 * VideoPlayer — plays MP4 segments based on PlaybackTarget from backend.
 *
 * v2 changes:
 *   - Receives a PlaybackTarget object (from /api/playback), not raw segments
 *   - Backend resolves timestamp → segment + offset, frontend just plays
 *   - Preloads next segment for gapless advance
 *   - No client-side segment math = no race conditions
 *
 * Playback lifecycle:
 *   1. Parent calls /api/playback?camera=X&ts=Y
 *   2. Parent passes PlaybackTarget as prop
 *   3. VideoPlayer sets <video src="{stream_url}#t={offset}">
 *   4. On segment end, auto-advances using next_segment_id
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { formatTime } from '../utils/time.js';

export default function VideoPlayer({ playbackTarget, camera, onTimeUpdate }) {
  const videoRef = useRef(null);
  const preloadRef = useRef(null); // hidden <video> for next segment preload
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(null);
  const [error, setError] = useState(null);

  /**
   * Load a new playback target into the video element.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    setError(null);

    const url = playbackTarget.stream_url;
    const offset = playbackTarget.offset_sec;

    // Set source — use #t= fragment for initial seek
    const fullUrl = offset > 0 ? `${url}#t=${offset.toFixed(2)}` : url;

    // Only reload if the segment actually changed
    const currentBase = video.src ? new URL(video.src, window.location.origin).pathname : '';
    const newBase = url;

    if (currentBase !== newBase) {
      video.src = fullUrl;
      video.load();
    } else if (Math.abs(video.currentTime - offset) > 0.5) {
      // Same segment, different position — just seek
      video.currentTime = offset;
    }

    // Preload next segment
    if (playbackTarget.next_segment_id && preloadRef.current) {
      const nextUrl = `/api/segment/${playbackTarget.next_segment_id}/stream`;
      preloadRef.current.src = nextUrl;
      preloadRef.current.preload = 'auto';
    }
  }, [playbackTarget]);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch((err) => {
        setError('Playback failed — segment may be unavailable');
      });
    } else {
      video.pause();
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    const absoluteTs = playbackTarget.segment_start_ts + video.currentTime;
    setDisplayTime(absoluteTs);

    // Notify parent so timeline cursor can track playback position
    if (onTimeUpdate) onTimeUpdate(absoluteTs);
  }, [playbackTarget, onTimeUpdate]);

  const handleEnded = useCallback(() => {
    // Auto-advance: swap preloaded next segment into main player
    if (!playbackTarget?.next_segment_id) {
      setIsPlaying(false);
      return;
    }

    const video = videoRef.current;
    const preload = preloadRef.current;
    if (!video || !preload || !preload.src) {
      setIsPlaying(false);
      return;
    }

    // Swap: preloaded becomes active
    video.src = preload.src;
    video.load();
    video.play().catch(() => {});

    // Clear preload (parent will provide new target if needed)
    preload.src = '';
  }, [playbackTarget]);

  const handleError = useCallback(() => {
    setError('Failed to load video segment');
    setIsPlaying(false);
  }, []);

  const hasTarget = playbackTarget != null;

  return (
    <div style={{ background: '#000', borderRadius: 6, overflow: 'hidden' }}>
      <video
        ref={videoRef}
        style={{
          width: '100%',
          display: 'block',
          maxHeight: 480,
          background: '#000',
          minHeight: hasTarget ? 270 : 120,
        }}
        onTimeUpdate={handleTimeUpdate}
        onError={handleError}
        onEnded={handleEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        playsInline
        muted
      />

      {/* Hidden preload element for next segment */}
      <video
        ref={preloadRef}
        style={{ display: 'none' }}
        preload="auto"
        muted
      />

      {/* Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          background: '#111',
          borderTop: '1px solid #333',
        }}
      >
        <button
          onClick={handlePlay}
          disabled={!hasTarget}
          style={{
            background: 'none',
            border: '1px solid #555',
            color: hasTarget ? '#fff' : '#555',
            padding: '4px 16px',
            borderRadius: 4,
            cursor: hasTarget ? 'pointer' : 'default',
            fontSize: 13,
          }}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>

        <span style={{ color: '#aaa', fontSize: 12, fontFamily: 'monospace' }}>
          {displayTime != null ? formatTime(displayTime) : '--:--:--'}
        </span>

        {hasTarget && (
          <span style={{ color: '#555', fontSize: 11, marginLeft: 'auto' }}>
            segment {playbackTarget.segment_id}
            {playbackTarget.next_segment_id && ' → ' + playbackTarget.next_segment_id}
            {' · '}
            {camera}
          </span>
        )}

        {error && (
          <span style={{ color: '#f44', fontSize: 12, marginLeft: 'auto' }}>
            {error}
          </span>
        )}

        {!hasTarget && !error && (
          <span style={{ color: '#555', fontSize: 12 }}>
            Click timeline to seek
          </span>
        )}
      </div>
    </div>
  );
}
