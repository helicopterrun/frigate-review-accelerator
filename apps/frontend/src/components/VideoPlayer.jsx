import { useRef, useEffect } from 'react';

export default function VideoPlayer({ playback, preview, playing, onPlay, onPause, onTimeUpdate }) {
  const videoRef = useRef(null);

  // Use HLS URL if available, fallback to stream_url
  const videoSrc = playback?.hls_url || playback?.stream_url || null;

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoSrc) return;
    vid.src = videoSrc;
    if (playback?.offset_sec) {
      vid.currentTime = playback.offset_sec;
    }
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

  return (
    <div className="video-player">
      {preview && !playing && (
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
        style={{ display: playing && videoSrc ? 'block' : 'none' }}
        onPause={onPause}
        onPlay={onPlay}
        onTimeUpdate={(e) => onTimeUpdate?.(e.target.currentTime)}
        playsInline
        controls
      />
      {!preview && !videoSrc && (
        <div className="video-placeholder">
          Select a point on the timeline
        </div>
      )}
    </div>
  );
}
