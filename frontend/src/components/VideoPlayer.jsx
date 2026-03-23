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
  preloadTargetTs = null,
  preloadTarget = null,
  autoplayActive = false,
  onPlaybackStateChange = null,
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

  // TODO: add frontend test — when preload ts matches playbackTarget ts,
  // the Hls swap path fires and loadHls is NOT called.
  const hlsPreloadRef = useRef(null);     // Hls instance for speculative preload
  const preloadCameraRef = useRef(null);
  const preloadTargetTsRef = useRef(null);
  const preloadRequestIdRef = useRef(0);  // cancels stale preload fetches

  const displayTimeRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(null);
  const [error, setError] = useState(null);
  const [hlsMode, setHlsMode] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const [isMuted, setIsMuted] = useState(() => {
    const stored = localStorage.getItem('frigate-muted');
    // stored === 'false' means user explicitly unmuted last session
    return stored === 'false' ? false : true;
  });
  const [hasAudio, setHasAudio] = useState(null); // null = unknown

  // Sticky-last-frame: only update displayedPreviewUrl when the new image loads.
  // This prevents black flashes between frames during rapid scrubbing.
  const [displayedPreviewUrl, setDisplayedPreviewUrl] = useState(null);

  // TODO: add frontend test — displayedPreviewUrl must be null immediately
  // after camera prop changes, before the new camera's preview loads.
  // Clear stale preview image immediately on camera change so we never show
  // the previous camera's last frame on top of the new camera's video.
  useEffect(() => {
    setDisplayedPreviewUrl(null);
  }, [camera]);

  useEffect(() => {
    if (!scrubPreviewUrl) {
      // Intentional: do not clear displayedPreviewUrl here. The camera-change
      // effect (above) clears it on camera switch. Keeping the last frame
      // during the 75ms debounce window prevents a black flash.
      return;
    }

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

  // HOOKS ORDER INVARIANT: all useCallback definitions must appear before
  // any useEffect that lists them as dependencies. Reordering these will
  // cause a ReferenceError (temporal dead zone) on component mount.
  // See: fix(frontend): hooks ordering crash — destroyHlsPreload before init

  /** Destroy existing hls.js instance if any. Stable — no external deps.
   *  Does NOT touch hlsPreloadRef — preload lifecycle is managed separately. */
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      console.log('[HLS] destroy');
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    isHlsActive.current = false;
    hlsWindowEndTs.current = null;
    _hlsExtendingRef.current = false;
  }, []);

  /** Destroy speculative HLS preload instance if any. Stable — no external deps. */
  const destroyHlsPreload = useCallback(() => {
    if (hlsPreloadRef.current) {
      hlsPreloadRef.current.destroy();
      hlsPreloadRef.current = null;
    }
    preloadCameraRef.current = null;
    preloadTargetTsRef.current = null;
  }, []);

  /** Load (or reload) an HLS source into the video element via hls.js or native HLS. */
  const loadHls = useCallback((video, hlsUrl, seekOffset) => {
    hlsWindowEndTs.current = _parseHlsWindowEnd(hlsUrl);

    if (Hls.isSupported()) {
      destroyHls();
      setHlsMode(true);

      console.log('[HLS] init', hlsUrl);
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
        console.log('[VIDEO] muted?', video.muted);
        video.play().then(() => {
          console.log('[VIDEO] play() success');
        }).catch((e) => {
          console.warn('[VIDEO] play() FAILED', e.name, e.message);
        });
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        console.warn('[HLS] error', data);
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
        console.log('[VIDEO] muted?', video.muted);
        video.play().then(() => {
          console.log('[VIDEO] play() success');
        }).catch((e) => {
          console.warn('[VIDEO] play() FAILED', e.name, e.message);
        });
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

  // ── Speculative HLS preload — initiated by VerticalTimeline slow-scrub hint ──
  useEffect(() => {
    if (!preloadTargetTs || !camera || !Hls.isSupported()) return;

    // Skip if main player is already playing near this timestamp
    if (
      playbackTarget &&
      Math.abs(playbackTarget.requested_ts - preloadTargetTs) < 5
    ) return;

    // Skip if already preloaded for this exact camera + ts window
    if (
      hlsPreloadRef.current &&
      preloadCameraRef.current === camera &&
      preloadTargetTsRef.current !== null &&
      Math.abs(preloadTargetTsRef.current - preloadTargetTs) < 5
    ) return;

    // Cancel any previous in-flight preload fetch
    destroyHlsPreload();
    preloadRequestIdRef.current++;
    const myId = preloadRequestIdRef.current;

    fetchPlaybackTarget(camera, preloadTargetTs)
      .then(target => {
        // Discard if superseded by a newer preload request
        if (myId !== preloadRequestIdRef.current) return;
        if (!target?.hls_url) return;

        const hls = new Hls({
          ...HLS_CONFIG,
          autoStartLoad: true,
          startFragPrefetch: true,
          maxBufferLength: 10,
          maxMaxBufferLength: 15,
        });
        hls.loadSource(target.hls_url);
        hls.attachMedia(preloadRef.current);
        hlsPreloadRef.current = hls;
        preloadCameraRef.current = camera;
        preloadTargetTsRef.current = preloadTargetTs;

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) destroyHlsPreload();
        });
      })
      .catch(() => {});

    // Do NOT destroy preload on cleanup. Let it persist until the next
    // preloadTargetTs change or until playback consumes it via swap below.
    // destroyHlsPreload() is called lazily at the top of this effect on the
    // next invocation.
  }, [preloadTargetTs, camera, playbackTarget, destroyHlsPreload]);

  // ── Idle preload — full PlaybackTarget delivered by App.jsx idle system ──────
  // This preload runs during the 400–1500ms idle window before autoplay fires.
  // Unlike the slow-scrub preload above (which fetches its own target), this
  // receives a pre-fetched target and loads it directly into the preload element.
  // When App.jsx promotes preloadTarget → playbackTarget at t=1500ms, the
  // existing hlsPreloadRef swap path fires and playback starts near-instantly.
  // TODO: test swap path — preloadTarget promoted to playbackTarget at
  //   autoplayRunning=true triggers existing hlsPreloadRef swap in VideoPlayer
  useEffect(() => {
    if (!preloadTarget?.hls_url || !Hls.isSupported()) return;
    // Supersedes any in-flight slow-scrub preload for the same element
    destroyHlsPreload();
    const hls = new Hls({
      ...HLS_CONFIG,
      autoStartLoad: true,
      startFragPrefetch: true,
      maxBufferLength: 10,
      maxMaxBufferLength: 15,
    });
    hls.loadSource(preloadTarget.hls_url);
    hls.attachMedia(preloadRef.current);
    hlsPreloadRef.current = hls;
    preloadCameraRef.current = preloadTarget.camera ?? camera;
    preloadTargetTsRef.current = preloadTarget.requested_ts;
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) destroyHlsPreload();
    });
  }, [preloadTarget, camera, destroyHlsPreload]);

  // ── Diagnostic: track playbackTarget changes ──────────────────────────────
  useEffect(() => {
    console.log('[VIDEO] playbackTarget changed:', playbackTarget);
  }, [playbackTarget]);

  // ── Diagnostic: attach one-time video element event listeners ─────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPause   = () => console.log('[VIDEO] pause event');
    const onWaiting = () => console.log('[VIDEO] waiting');
    const onStalled = () => console.log('[VIDEO] stalled');
    const onEnded   = () => console.log('[VIDEO] ended');
    const onError   = (e) => console.log('[VIDEO] error', e);
    video.addEventListener('pause',   onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('ended',   onEnded);
    video.addEventListener('error',   onError);
    return () => {
      video.removeEventListener('pause',   onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('ended',   onEnded);
      video.removeEventListener('error',   onError);
    };
  }, []); // intentional: attach once to the stable DOM element

  /**
   * Load a new playback target into the video element.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackTarget) return;

    setHasAudio(null);
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
        console.log('[VIDEO] loading source', {
          hls: playbackTarget.hls_url,
          mp4: playbackTarget.stream_url,
          seekOffset,
        });

        // Fast path: swap preloaded Hls instance → near-instant playback.
        // Conditions: same camera, requested ts within 5s of preloaded ts,
        // manifest already fetched and buffering into preloadRef.
        // TODO: add frontend test — swap fires when ts matches; loadHls not called.
        if (
          Hls.isSupported() &&
          hlsPreloadRef.current &&
          preloadCameraRef.current === camera &&
          preloadTargetTsRef.current !== null &&
          Math.abs(playbackTarget.requested_ts - preloadTargetTsRef.current) < 5
        ) {
          console.log('[HLS] preload swap — instant play');

          // Capture the preload instance BEFORE nulling refs and before destroyHls.
          // Order matters: null the preload refs first so destroyHls cannot
          // accidentally reach the preload instance through any shared state.
          const preloadHls = hlsPreloadRef.current;
          hlsPreloadRef.current = null;
          preloadCameraRef.current = null;
          preloadTargetTsRef.current = null;

          destroyHls(); // destroys OLD main player only — preloadHls is unaffected

          // CRITICAL: preloadHls is currently bound to preloadRef.current (the
          // hidden <video> element). It MUST be rebound to the main video element
          // before use. Without detachMedia() + attachMedia(video), the Hls instance
          // will play silently into the hidden element and the user sees a frozen
          // screen with no error. This step is non-negotiable.
          preloadHls.detachMedia();
          preloadHls.attachMedia(video);

          hlsRef.current = preloadHls;
          isHlsActive.current = true;
          hlsWindowEndTs.current = _parseHlsWindowEnd(playbackTarget.hls_url);

          const doSeekAndPlay = () => {
            video.currentTime = seekOffset;
            hlsStartOffset.current = video.currentTime;
            video.play()
              .then(() => {
                console.log('[VIDEO] preload swap play() success');
              })
              .catch(e => {
                console.warn('[VIDEO] preload swap play() failed — falling through', e.message);
                // Hard failure: fall through to normal HLS load so the user
                // always gets playback even if the swap path fails.
                loadHls(video, playbackTarget.hls_url, seekOffset);
              });
          };

          // Attach first to close the TOCTOU window, then call immediately if ready.
          // If readyState drops from >= 1 to 0 between the check and listener
          // attachment (concurrent destroyHls), doSeekAndPlay would never fire.
          // Attaching unconditionally guarantees exactly-once delivery.
          video.addEventListener('loadedmetadata', doSeekAndPlay, { once: true });
          if (video.readyState >= 1) {
            // Already have metadata — fire now; remove the { once } listener first
            // so it does not double-fire if a loadedmetadata event follows.
            video.removeEventListener('loadedmetadata', doSeekAndPlay);
            doSeekAndPlay();
          }
          // TODO: Vitest test — preload swap calls doSeekAndPlay when readyState
          // drops to 0 after the conditional check (requires fake MediaElement).

          return () => { destroyHls(); };
        }
        // Normal path — no usable preload available, load fresh

        loadHls(video, playbackTarget.hls_url, seekOffset);
        return () => { destroyHls(); };
      }
    }

    // ── Path 3: MP4 segment fallback ─────────────────────────────────────────
    destroyHls();
    setHlsMode(false);

    const url = playbackTarget.stream_url;
    // Capture offset in a local const so the onloadedmetadata closure below
    // always refers to this invocation's value even if playbackTarget is
    // replaced before the event fires.
    const offset = playbackTarget.offset_sec;
    console.log('[VIDEO] loading source', {
      hls: null,
      mp4: url,
      seekOffset: offset,
    });

    // TODO: when a frontend test harness is introduced, add tests for:
    //   - offset exactly equal to duration fires 'ended' without the fix
    //   - clampOffset returns duration - 0.05 when offset >= duration
    //   - clampOffset returns offset unchanged when offset < duration
    //   - clampOffset returns 0 when video.duration is NaN (pre-metadata)
    //   - clampOffset returns 0 when video.duration is Infinity
    //   - seek is applied via onloadedmetadata, not via #t= fragment
    //   - onloadedmetadata is nulled after firing (no listener accumulation)
    //   - same-source re-seek threshold is 0.1s, not 0.5s

    // Clamp rawOffset to [0, duration - 0.05] so an offset at or beyond the
    // end of the segment does not trigger an immediate 'ended' event.
    // Guards with Number.isFinite because video.duration is NaN before
    // metadata loads and Infinity on certain stream types.
    const clampOffset = (vid, rawOffset) => {
      if (Number.isFinite(vid.duration) && vid.duration > 0.1) {
        return Math.min(rawOffset, vid.duration - 0.05);
      }
      return 0;
    };

    const currentBase = video.src
      ? new URL(video.src, window.location.origin).pathname
      : '';

    if (currentBase !== url) {
      // Load without a #t= fragment — seek after onloadedmetadata so we
      // know the actual duration and can clamp. The #t= hint is unreliable
      // when offset >= duration: the browser jumps to EOF and fires 'ended'
      // before the user sees any frames.
      video.src = url;
      video.load();
      // Assign directly (not addEventListener) to avoid accumulating
      // listeners across rapid playback-target changes.
      video.onloadedmetadata = () => {
        video.onloadedmetadata = null;
        const safeOffset = clampOffset(video, offset);
        if (safeOffset > 0.01) video.currentTime = safeOffset;
      };
    } else if (Math.abs(video.currentTime - offset) > 0.1) {
      video.currentTime = clampOffset(video, offset);
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
    return () => {
      destroyHls();
      destroyHlsPreload();
    };
  }, [destroyHls, destroyHlsPreload]);

  // Sync muted state to the video element whenever isMuted changes.
  // Also fires after HLS reloads since handleLoadedMetadata re-applies it there.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isMuted;
  }, [isMuted]);

  // Pause video and cancel preload when autoplay deactivates (user interacted).
  // On initial mount autoplayActive is false and video is paused — no-op.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!autoplayActive) {
      if (!video.paused) video.pause();
      destroyHlsPreload(); // discard buffered preload — next idle window starts fresh
    }
  }, [autoplayActive, destroyHlsPreload]);

  const handleToggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      localStorage.setItem('frigate-muted', String(next));
      if (videoRef.current) {
        videoRef.current.muted = next;
      }
      return next;
    });
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // Priority 1: Hls.js audio track info
    if (hlsRef.current && Array.isArray(hlsRef.current.audioTracks)) {
      setHasAudio(hlsRef.current.audioTracks.length > 0);
    }
    // Priority 2: native audioTracks API (Chrome/Edge; absent on Safari)
    else if (video.audioTracks && typeof video.audioTracks.length === 'number') {
      setHasAudio(video.audioTracks.length > 0);
    }
    // Priority 3: unknown — leave null, allow user to try audio
    else {
      setHasAudio(null);
    }

    // Re-apply muted state after metadata loads — hls.js reloads reset it
    video.muted = isMuted;
  }, [isMuted]);

  const handlePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      console.log('[VIDEO] muted?', video.muted);
      video.play().then(() => {
        console.log('[VIDEO] play() success');
      }).catch((e) => {
        console.warn('[VIDEO] play() FAILED', e.name, e.message);
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
    displayTimeRef.current = absoluteTs;
    if (onTimeUpdate) onTimeUpdate(absoluteTs);

    if (isHlsActive.current && hlsWindowEndTs.current && !_hlsExtendingRef.current) {
      const secsUntilWindowEnd = hlsWindowEndTs.current - absoluteTs;
      if (secsUntilWindowEnd > 0 && secsUntilWindowEnd < WINDOW_EXTEND_THRESHOLD_SEC) {
        extendHlsWindow(absoluteTs);
      }
    }
  }, [playbackTarget, onTimeUpdate, extendHlsWindow]);

  // TODO: test displayTimeRef is current when handleEnded fires after
  // long playback session — stale state version of this bug was fixed
  // in fix(frontend): displayTimeRef for handleEnded stale closure
  const handleEnded = useCallback(() => {
    if (isHlsActive.current) {
      if (displayTimeRef.current && !_hlsExtendingRef.current) {
        extendHlsWindow(displayTimeRef.current);
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
        console.log('[VIDEO] muted?', video.muted);
        video.play().then(() => {
          console.log('[VIDEO] play() success');
        }).catch((e) => {
          console.warn('[VIDEO] play() FAILED', e.name, e.message);
        });
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
  const showOverlay = scrubPreviewUrl != null && !isPlaying && eventSnapshot == null;
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
          onLoadedMetadata={handleLoadedMetadata}
          onError={handleError}
          onEnded={handleEnded}
          onPlay={() => {
            setIsPlaying(true);
            if (onPlaybackStart) onPlaybackStart();
            if (onPlaybackStateChange) onPlaybackStateChange(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            if (onPlaybackStateChange) onPlaybackStateChange(false);
          }}
          playsInline
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

        {/* TODO: add React Testing Library tests for:
              - mute toggle writes to localStorage
              - isMuted persists across remount (localStorage read on init)
              - hasAudio tri-state (true / null / false) button appearance
              - video.muted updated immediately in handleToggleMute handler
            Add when a frontend test harness is introduced. */}
        <button
          onClick={handleToggleMute}
          title={
            hasAudio === false
              ? 'No audio track detected'
              : isMuted
                ? 'Unmute'
                : 'Mute'
          }
          style={{
            background: 'none',
            border: '1px solid #555',
            color:
              hasAudio === false
                ? '#333'
                : isMuted
                  ? '#aaa'
                  : '#fff',
            opacity: hasAudio === false ? 0.6 : 1,
            padding: isMobile ? '10px 14px' : '4px 12px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 17,
            minHeight: isMobile ? 44 : undefined,
            flexShrink: 0,
          }}
        >
          {isMuted ? '🔇' : '🔊'}
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
