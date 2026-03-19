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
 *
 * scrubPreviewUrl prop:
 *   When non-null, renders a position:absolute overlay over the video showing
 *   the preview JPEG. Uses sticky-last-frame: the overlay image only updates
 *   when a new Image fires .onload, preventing black flashes during rapid scrub.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { formatTime } from '../utils/time.js';
import { fetchPlaybackTarget } from '../utils/api.js';

const LABEL_COLORS = {
  person: '#4CAF50',
  car: '#2196F3',
  dog: '#FF9800',
  cat: '#9C27B0',
  default: '#607D8B',
};

const WINDOW_EXTEND_THRESHOLD_SEC = 60;

function _parseHlsWindowEnd(hlsUrl) {
  const m = hlsUrl.match(/\/end\/(\d+)/);
  return m ? parseFloat(m[1]) : null;
}

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  startPosition: -1,
};

export default function VideoPlayer({
  playbackTarget,
  camera,
  onTimeUpdate,
  onSegmentAdvance,
  scrubPreviewUrl,
  isMobile = false,
  eventSnapshot = null,
  onSeek = null,
  onPlaybackStart = null,
}) {
  const videoRef = useRef(null);
  const preloadRef = useRef(null);
  const hlsRef = useRef(null);
  const hlsStartOffset = useRef(0);
  const isHlsActive = useRef(false);
  const loadingImgRef = useRef(null);
  const hlsWindowEndTs = useRef(null);
  const _hlsExtendingRef = useRef(false);
  const _lastExtendTs = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(null);
  const [error, setError] = useState(null);
  const [hlsMode, setHlsMode] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  // Sticky-last-frame: only update displayedPreviewUrl when the new image loads.
  // This prevents black flashes between frames during rapid scrubbing.
  const [displayedPreviewUrl, setDisplayedPreviewUrl] = useState(null);

  useEffect(() => {
    if (!scrubPreviewUrl) return;

    // Cancel any in-flight load
    if (loadingImgRef.current) {
      loadingImgRef.current.onload = null;
      loadingImgRef.current.onerror = null;
      loadingImgRef.current = null;
    }

    const img = new Image();
    loadingImgRef.current = img;

    img.onload = () => {
      setDisplayedPreviewUrl(scrubPreviewUrl);
      loadingImgRef.current = null;
    };
    img.onerror = () => {
      // Keep last good frame rather than going blank
      loadingImgRef.current = null;
    };

    img.src = scrubPreviewUrl;

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [scrubPreviewUrl]);

  /** Destroy existing hls.js instance if any. Stable — no external deps. */
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    isHlsActive.current = false;
    hlsWindowEndTs.current = null;
    _hlsExtendingRef.current = false;
  }, []);

  /** Load (or reload) an HLS source into the video element via hls.js or native HLS. */
  const loadHls = useCallback((video, hlsUrl, seekOffset) => {
    hlsWindowEndTs.current = _parseHlsWindowEnd(hlsUrl);

    if (Hls.isSupported()) {
      destroyHls();
      setHlsMode(true);

      const hls = new Hls(HLS_CONFIG);
      hlsRef.current = hls;
      isHlsActive.current = true;
      // Re-parse after destroyHls cleared it
      hlsWindowEndTs.current = _parseHlsWindowEnd(hlsUrl);

      hls.loadSource(hlsUrl);
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
          destroyHls();
          setHlsMode(false);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS path (Safari) — reload src in-place
      video.src = hlsUrl;
      video.load();
      const onMeta = () => {
        if (seekOffset > 0) {
          video.currentTime = seekOffset;
        }
        hlsStartOffset.current = video.currentTime;
        video.play().catch(() => {});
      };
      video.addEventListener('loadedmetadata', onMeta, { once: true });
    }
  }, [destroyHls]);

  /** Extend the HLS window to cover currentAbsoluteTs + 24h, preserving playback.
   *  camera must be in the dep array — stale closures here cause cross-camera fetches. */
  const extendHlsWindow = useCallback(async (currentAbsoluteTs) => {
    if (_hlsExtendingRef.current) return;
    if (Math.abs(currentAbsoluteTs - _lastExtendTs.current) < 30) return;
    _hlsExtendingRef.current = true;
    _lastExtendTs.current = currentAbsoluteTs;
    const video = videoRef.current;
    if (!video) { _hlsExtendingRef.current = false; return; }
    try {
      const newTarget = await fetchPlaybackTarget(camera, currentAbsoluteTs);
      if (newTarget?.hls_url) {
        loadHls(video, newTarget.hls_url, Math.min(newTarget.offset_sec, 30));
      }
    } catch (e) {
      console.warn('HLS window extension failed:', e);
    } finally {
      _hlsExtendingRef.current = false;
    }
  }, [camera, loadHls]);

  /**
   * Load a new playback target into the video element.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    setError(null);
    _hlsExtendingRef.current = false;
    _lastExtendTs.current = 0;

    // ── Path 1 & 2: Frigate HLS VOD ──────────────────────────────────────────
    if (playbackTarget.hls_url) {
      // Compute seek offset within the HLS stream.
      // The HLS window starts at max(seg_start, requested_ts - 30).
      // So: seekOffset = requested_ts - window_start = min(offset_sec, 30)
      const seekOffset = Math.min(playbackTarget.offset_sec, 30);

      if (Hls.isSupported() || video.canPlayType('application/vnd.apple.mpegurl')) {
        loadHls(video, playbackTarget.hls_url, seekOffset);
        return () => { destroyHls(); };
      }
    }

    // ── Path 3: MP4 segment fallback ─────────────────────────────────────────
    destroyHls();
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
  }, [playbackTarget, loadHls, destroyHls]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { destroyHls(); };
  }, [destroyHls]);

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
      absoluteTs = playbackTarget.requested_ts +
                   (video.currentTime - hlsStartOffset.current);
    } else {
      absoluteTs = playbackTarget.segment_start_ts + video.currentTime;
    }

    setDisplayTime(absoluteTs);
    if (onTimeUpdate) onTimeUpdate(absoluteTs);

    if (isHlsActive.current && hlsWindowEndTs.current && !_hlsExtendingRef.current) {
      const secsUntilWindowEnd = hlsWindowEndTs.current - absoluteTs;
      if (secsUntilWindowEnd > 0 && secsUntilWindowEnd < WINDOW_EXTEND_THRESHOLD_SEC) {
        extendHlsWindow(absoluteTs);
      }
    }
  }, [playbackTarget, onTimeUpdate, extendHlsWindow]);

  const handleEnded = useCallback(() => {
    if (isHlsActive.current) {
      if (displayTime && !_hlsExtendingRef.current) {
        extendHlsWindow(displayTime);
        return;
      }
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
  }, [playbackTarget, onSegmentAdvance, displayTime, extendHlsWindow]);

  const handleError = useCallback(() => {
    setError('Failed to load video segment');
    setIsPlaying(false);
  }, []);

  const hasTarget = playbackTarget != null;
  const showOverlay = scrubPreviewUrl != null && eventSnapshot == null;
  const showPlaceholder = !hasTarget && !showOverlay && !eventSnapshot;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#000',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {/* Viewer area: video + overlay + placeholder */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <video
          ref={videoRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            background: '#000',
            objectFit: 'contain',
          }}
          onTimeUpdate={handleTimeUpdate}
          onError={handleError}
          onEnded={handleEnded}
          onPlay={() => {
            setIsPlaying(true);
            if (onPlaybackStart) onPlaybackStart();
          }}
          onPause={() => setIsPlaying(false)}
          playsInline
          muted
        />

        {/* Hidden preload element for next MP4 segment */}
        <video ref={preloadRef} style={{ display: 'none' }} preload="auto" muted />

        {/* Scrub preview overlay — shown while hovering the timeline */}
        {showOverlay && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#000',
            }}
          >
            {displayedPreviewUrl && (
              <img
                src={displayedPreviewUrl}
                alt="Preview"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            )}
          </div>
        )}

        {/* Event snapshot overlay — shown when navigating to an event */}
        {eventSnapshot && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#000',
          }}>
            <img
              src={eventSnapshot.url}
              alt={eventSnapshot.label}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            <div style={{
              position: 'absolute', top: 10, left: 10,
              background: 'rgba(0,0,0,0.75)',
              border: `1px solid ${LABEL_COLORS[eventSnapshot.label] ?? LABEL_COLORS.default}`,
              color: LABEL_COLORS[eventSnapshot.label] ?? LABEL_COLORS.default,
              padding: '3px 10px', borderRadius: 12,
              fontSize: 13, fontFamily: 'monospace',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: LABEL_COLORS[eventSnapshot.label] ?? LABEL_COLORS.default,
                display: 'inline-block',
              }}/>
              {eventSnapshot.label}
              {eventSnapshot.score != null && (
                <span style={{ color: '#888', fontSize: 11 }}>
                  {Math.round(eventSnapshot.score * 100)}%
                </span>
              )}
            </div>
            <button
              onClick={() => { if (onSeek && eventSnapshot) onSeek(eventSnapshot.ts); }}
              style={{
                position: 'absolute', top: 8, right: 8,
                background: 'rgba(0,0,0,0.6)', border: '1px solid #333',
                color: '#888', width: 28, height: 28, borderRadius: 14,
                cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >✕</button>
          </div>
        )}

        {/* Placeholder when no playback target and no preview overlay */}
        {showPlaceholder && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              pointerEvents: 'none',
            }}
          >
            <span style={{ fontSize: 52, color: '#2a2d37' }}>▶</span>
            <span style={{ color: '#3a3d47', fontSize: 17, fontFamily: 'monospace' }}>
              Hover timeline to preview · click to play
            </span>
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 8 : 12,
          padding: '8px 12px',
          background: '#111',
          borderTop: '1px solid #333',
          flexShrink: 0,
        }}
      >
        <button
          onClick={handlePlay}
          disabled={!hasTarget}
          style={{
            background: 'none',
            border: '1px solid #555',
            color: hasTarget ? '#fff' : '#555',
            padding: isMobile ? '10px 14px' : '4px 16px',
            borderRadius: 4,
            cursor: hasTarget ? 'pointer' : 'default',
            fontSize: 17,
            minHeight: isMobile ? 44 : undefined,
            flexShrink: 0,
          }}
        >
          {isPlaying ? '⏸' : '▶'}
          {!isMobile && (isPlaying ? ' Pause' : ' Play')}
        </button>

        <span style={{ color: '#aaa', fontSize: 17, fontFamily: 'monospace' }}>
          {displayTime != null ? formatTime(displayTime) : '--:--:--'}
        </span>

        {hasTarget && (
          <span
            style={{
              fontSize: 15,
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

        {/* Desktop: segment info inline */}
        {hasTarget && !isMobile && (
          <span style={{ color: '#555', fontSize: 16, marginLeft: 'auto' }}>
            segment {playbackTarget.segment_id}
            {!hlsMode && playbackTarget.next_segment_id && ' → ' + playbackTarget.next_segment_id}
            {' · '}
            {camera}
          </span>
        )}

        {/* Mobile: detail toggle button */}
        {hasTarget && isMobile && (
          <button
            onClick={() => setDetailOpen((v) => !v)}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: '1px solid #333',
              color: detailOpen ? '#aaa' : '#555',
              width: 28, height: 28, borderRadius: 14,
              cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >ⓘ</button>
        )}

        {error && (
          <span style={{ color: '#f44', fontSize: 16, marginLeft: isMobile ? 'auto' : undefined }}>
            {error}
          </span>
        )}

        {!hasTarget && !error && (
          <span style={{ color: '#555', fontSize: 16 }}>
            {isMobile ? 'Tap timeline' : 'Click timeline to seek'}
          </span>
        )}
      </div>

      {/* Mobile detail drawer */}
      {isMobile && (
        <div style={{
          maxHeight: detailOpen ? 60 : 0,
          overflow: 'hidden',
          transition: 'max-height 0.2s ease',
          background: '#0a0c12',
          padding: detailOpen ? '6px 12px' : '0 12px',
          fontSize: 12,
          color: '#555',
          borderTop: detailOpen ? '1px solid #222' : 'none',
        }}>
          {hasTarget && `segment ${playbackTarget.segment_id} · ${camera}`}
        </div>
      )}
    </div>
  );
}
