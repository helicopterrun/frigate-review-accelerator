import { useState, useCallback } from 'react';
import Timeline from './components/Timeline.jsx';
import VideoPlayer from './components/VideoPlayer.jsx';
import ZoomControls from './components/ZoomControls.jsx';
import { useSocket } from './hooks/useSocket.js';
import { useTimelineAccelerator } from './hooks/useTimelineAccelerator.js';
import './App.css';

const CAMERAS = [
  'street-doorbell','street-overview','street-west','street-east',
  'rooftop-west','street-package','alley-west','alley-east','alley-overview',
];

export default function App() {
  const [camera, setCamera] = useState(CAMERAS[0]);
  const { socket, status } = useSocket();
  const tl = useTimelineAccelerator(camera, socket);

  const handleSeek = useCallback((ts) => {
    tl.onSeek(ts);
    tl.seek(ts);
  }, [tl.onSeek, tl.seek]);

  const cameraSelector = (
    <select
      className="camera-select"
      value={camera}
      onChange={e => setCamera(e.target.value)}
    >
      {CAMERAS.map(c => <option key={c} value={c}>{c}</option>)}
    </select>
  );

  const typeBCount = tl.resolvedSlots.filter(s => s.resolvedStrategy === 'B').length;

  if (tl.startTs == null || tl.endTs == null) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Frigate Review Accelerator</h1>
          {cameraSelector}
          <span className="socket-status" data-status={status}>
            {status}
          </span>
        </header>
        <div className="app-loading">
          {camera ? 'Loading timeline...' : 'Select a camera to begin'}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Frigate Review Accelerator</h1>
        {cameraSelector}
        <span className="socket-status" data-status={status}>
          {status}
        </span>
        <span className="slot-count">
          {tl.resolvedSlots.length}/60 {'\u00B7'} {typeBCount}B {tl.resolvedSlots.length - typeBCount}A
        </span>
      </header>
      <div className="app-body">
        <aside className="timeline-panel">
          <Timeline
            startTs={tl.startTs}
            endTs={tl.endTs}
            gaps={tl.timeline?.gaps ?? []}
            events={tl.timeline?.events ?? []}
            densityData={tl.density}
            cursorTs={tl.cursorTs}
            onSeek={handleSeek}
            onPan={tl.onPan}
            onPreviewRequest={tl.onPreviewRequest}
          />
          <ZoomControls
            rangeSec={tl.rangeSec}
            onZoomChange={tl.onZoomChange}
          />
        </aside>
        <main className="video-panel">
          <VideoPlayer
            playback={{ hls_url: tl.playbackUrl }}
            preview={tl.preview}
            playing={tl.playing}
            onPlay={tl.play}
            onPause={tl.pause}
          />
          <div className="resolved-slots-debug">
            <h3>Resolved Slots</h3>
            <div className="slot-grid">
              {tl.resolvedSlots.map((slot) => (
                <div
                  key={slot.slotIndex}
                  className={`slot-thumb ${slot.resolvedStrategy === 'B' ? 'slot-type-b' : ''}`}
                >
                  {slot.mediaUrl ? (
                    <img
                      src={slot.mediaUrl}
                      alt={`Slot ${slot.slotIndex}`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="slot-empty">{slot.slotIndex}</div>
                  )}
                  <span className={`slot-label ${slot.resolvedStrategy === 'B' ? 'slot-label-b' : ''}`}>
                    {slot.slotIndex} {slot.resolvedStrategy}
                    {slot.score != null ? ` ${(slot.score * 100).toFixed(0)}%` : ''}
                  </span>
                  {slot.winnerEntityId && (
                    <span className="slot-entity-badge">
                      {slot.winnerEntityId.split('-')[0]?.slice(-4)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
