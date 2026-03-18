/**
 * VideoPlayer — plays video via Frigate HLS VOD (preferred) or MP4 segments (fallback).
 *
 * Playback priority:
 *   1. playbackTarget.hls_url + Hls.isSupported()  → hls.js
 *   2. playbackTarget.hls_url + native HLS (Safari) → video.src directly
 *   3. Fallback: stream_url + offset fragment (existing MP4 segment path)
 *
 * When HLS is active:
 *   - Segment-advance logic (handleEnded, preloadRef) is suppressed —
 *     Frigate HLS stitches segments automatically.
 *   - absoluteTs = requested_ts + (currentTime - hlsStartOffset)
 *     Maps HLS stream-relative time back to wall-clock timestamps.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { formatTime } from '../utils/time.js';

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  startPosition: -1,
};

export default function VideoPlayer({ playbackTarget, camera, onTimeUpdate, onSegmentAdvance }) {
  const videoRef = useRef(null);
  const preloadRef = useRef(null);
  const hlsRef = useRef(null);
  const hlsStartOffset = useRef(0);
  const isHlsActive = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(null);
  const [error, setError] = useState(null);
  const [hlsMode, setHlsMode] = useState(false); // for UI indicator only

  /** Destroy existing hls.js instance if any. */
  function _destroyHls() {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    isHlsActive.current = false;
  }

  /**
   * Load a new playback target into the video element.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    setError(null);

    // ── Path 1 & 2: Frigate HLS VOD ──────────────────────────────────────────
    if (playbackTarget.hls_url) {
      // Compute seek offset within the HLS stream.
      // The HLS window starts at max(seg_start, requested_ts - 30).
      // So: seekOffset = requested_ts - window_start = min(offset_sec, 30)
      const seekOffset = Math.min(playbackTarget.offset_sec, 30);

      if (Hls.isSupported()) {
        // hls.js path (Chrome, Firefox, Edge, …)
        _destroyHls();
        setHlsMode(true);

        const hls = new Hls(HLS_CONFIG);
        hlsRef.current = hls;
        isHlsActive.current = true;

        hls.loadSource(playbackTarget.hls_url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (seekOffset > 0) {
            video.currentTime = seekOffset;
          }
          hlsStartOffset.current = video.currentTime;
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            setError('HLS playback error — trying fallback');
            _destroyHls();
            setHlsMode(false);
            // Fall through to MP4 in the next render (hls_url cleared by error state)
          }
        });

        return () => { _destroyHls(); };

      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS path (Safari)
        _destroyHls();
        setHlsMode(true);
        isHlsActive.current = true;

        video.src = playbackTarget.hls_url;
        video.load();

        const onMeta = () => {
          if (seekOffset > 0) {
            video.currentTime = seekOffset;
          }
          hlsStartOffset.current = video.currentTime;
          video.play().catch(() => {});
        };
        video.addEventListener('loadedmetadata', onMeta, { once: true });

        return () => {
          video.removeEventListener('loadedmetadata', onMeta);
          isHlsActive.current = false;
          setHlsMode(false);
        };
      }
    }

    // ── Path 3: MP4 segment fallback ─────────────────────────────────────────
    _destroyHls();
    setHlsMode(false);

    const url = playbackTarget.stream_url;
    const offset = playbackTarget.offset_sec;
    const fullUrl = offset > 0 ? `${url}#t=${offset.toFixed(2)}` : url;

    const currentBase = video.src ? new URL(video.src, window.location.origin).pathname : '';
    if (currentBase !== url) {
      video.src = fullUrl;
      video.load();
    } else if (Math.abs(video.currentTime - offset) > 0.5) {
      video.currentTime = offset;
    }

    // Preload next segment
    if (playbackTarget.next_segment_id && preloadRef.current) {
      const nextUrl = `/api/segment/${playbackTarget.next_segment_id}/stream`;
      preloadRef.current.src = nextUrl;
      preloadRef.current.preload = 'auto';
    }
  }, [playbackTarget]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { _destroyHls(); };
  }, []);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {
        setError('Playback failed — segment may be unavailable');
      });
    } else {
      video.pause();
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    let absoluteTs;
    if (isHlsActive.current) {
      // HLS: map stream-relative time back to wall-clock
      absoluteTs = playbackTarget.requested_ts +
                   (video.currentTime - hlsStartOffset.current);
    } else {
      // MP4: segment_start_ts + offset within segment
      absoluteTs = playbackTarget.segment_start_ts + video.currentTime;
    }

    setDisplayTime(absoluteTs);
    if (onTimeUpdate) onTimeUpdate(absoluteTs);
  }, [playbackTarget, onTimeUpdate]);

  const handleEnded = useCallback(() => {
    // When HLS is active, Frigate handles continuity — no manual advance needed
    if (isHlsActive.current) {
      setIsPlaying(false);
      return;
    }

    if (!playbackTarget?.next_segment_id) {
      setIsPlaying(false);
      return;
    }

    if (onSegmentAdvance) {
      onSegmentAdvance(playbackTarget.next_segment_id);
    } else {
      // Fallback for backwards compat (no parent handler)
      const video = videoRef.current;
      const preload = preloadRef.current;
      if (video && preload && preload.src) {
        video.src = preload.src;
        video.load();
        video.play().catch(() => {});
        preload.src = '';
      } else {
        setIsPlaying(false);
      }
    }
  }, [playbackTarget, onSegmentAdvance]);

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

      {/* Hidden preload element for next MP4 segment */}
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
            {!hlsMode && playbackTarget.next_segment_id && ' → ' + playbackTarget.next_segment_id}
            {' · '}
            {camera}
          </span>
        )}

        {hasTarget && (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 10,
              background: hlsMode ? 'rgba(76,175,80,0.15)' : 'rgba(100,100,100,0.15)',
              color: hlsMode ? '#4CAF50' : '#888',
              fontFamily: 'monospace',
              flexShrink: 0,
            }}
          >
            {hlsMode ? '● HLS' : '● MP4'}
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
