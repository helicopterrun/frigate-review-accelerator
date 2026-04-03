import { useRef, useEffect, useState } from 'react';
import Hls from 'hls.js';

// VITE_FRIGATE_URL lets nginx proxy Frigate's API over HTTPS.
// Falls back to the direct port for local dev.
const FRIGATE_URL = import.meta.env.VITE_FRIGATE_URL ?? `http://${window.location.hostname}:5000`;
const LIVE_REFRESH_MS = 1000;

export default function VideoPlayer({
  camera,
  playback,
  preview,
  playing,
  liveMode,
  loading,
  onPlay,
  onPause,
  onTimeUpdate,
}) {
  const videoRef = useRef(null);
  const [liveSrc, setLiveSrc] = useState(null);
  const liveTimerRef = useRef(null);

  const videoSrc = playback?.hls_url || playback?.stream_url || null;

  // Live view: poll latest.jpg every second
  useEffect(() => {
    if (!liveMode || !camera) {
      setLiveSrc(null);
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
      return;
    }

    const refresh = () => {
      setLiveSrc(`${FRIGATE_URL}/api/${camera}/latest.jpg?t=${Date.now()}`);
    };
    refresh();
    liveTimerRef.current = setInterval(refresh, LIVE_REFRESH_MS);

    return () => {
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    };
  }, [liveMode, camera]);

  // HLS/VOD playback
  const hlsRef = useRef(null);
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoSrc) return;

    // Destroy any previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(videoSrc);
      hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (playback?.offset_sec) vid.currentTime = playback.offset_sec;
      });
    } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      vid.src = videoSrc;
      if (playback?.offset_sec) vid.currentTime = playback.offset_sec;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [videoSrc, playback?.offset_sec]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (playing) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  }, [playing]);

  // Determine what to show
  const showLive = liveMode && liveSrc && !playing;
  const showPreview = !showLive && preview && !playing;
  const showVideo = playing && videoSrc;
  const showLoading = loading && !showLive && !showPreview && !showVideo;
  const showPlaceholder = !showLive && !showPreview && !showVideo && !showLoading;

  return (
    <div className="video-player">
      {showLive && (
        <div className="live-view">
          <img src={liveSrc} alt="Live" className="live-img" />
          <span className="live-badge">LIVE</span>
        </div>
      )}

      {showPreview && (
        <img
          src={preview}
          alt="Preview"
          className="preview-img"
          onClick={onPlay}
        />
      )}

      <video
        ref={videoRef}
        className="video-el"
        style={{ display: showVideo ? 'block' : 'none' }}
        onPause={onPause}
        onPlay={onPlay}
        onTimeUpdate={(e) => onTimeUpdate?.(e.target.currentTime)}
        playsInline
        controls
      />

      {showLoading && (
        <div className="video-placeholder">
          <div className="loading-spinner" />
          <span>Loading frames...</span>
        </div>
      )}

      {showPlaceholder && (
        <div className="video-placeholder">
          Scroll the timeline to browse recordings
        </div>
      )}
    </div>
  );
}
