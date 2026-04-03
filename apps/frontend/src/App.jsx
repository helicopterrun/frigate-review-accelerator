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
  const [showDebug, setShowDebug] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { socket, status } = useSocket();
  const tl = useTimelineAccelerator(camera, socket);

  const handleSeek = useCallback((ts) => {
    tl.onSeek(ts);
    tl.seek(ts);
  }, [tl.onSeek, tl.seek]);

  const typeBCount = tl.resolvedSlots.filter(s => s.resolvedStrategy === 'B').length;

  const cameraSelector = (
    <select
      className="camera-select"
      value={camera}
      onChange={e => setCamera(e.target.value)}
    >
      {CAMERAS.map(c => <option key={c} value={c}>{c}</option>)}
    </select>
  );

  if (tl.startTs == null || tl.endTs == null) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">Frigate Review</h1>
          <div className="header-controls">
            {cameraSelector}
            <span className="socket-status" data-status={status}>{status}</span>
          </div>
          <span className="socket-dot" data-status={status} title={status} />
          <div className="header-controls-mobile">
            {cameraSelector}
          </div>
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
        <h1 className="app-title">Frigate Review</h1>

        {/* Desktop: all controls inline */}
        <div className="header-controls">
          {cameraSelector}
          <span className="socket-status" data-status={status}>{status}</span>
          <span className="slot-count">
            {tl.resolvedSlots.length}/60 {'\u00B7'} {typeBCount}B {tl.resolvedSlots.length - typeBCount}A
          </span>
          <span className="freshness-badge" data-freshness={tl.semanticFreshness}>
            {tl.semanticFreshness}
          </span>
          <span className="playback-badge" data-state={tl.playbackState}>
            {tl.playbackState.replace(/_/g, ' ')}
          </span>
          <button
            className="debug-toggle"
            onClick={() => setShowDebug(v => !v)}
            title="Toggle debug panel"
          >
            {showDebug ? 'Hide Debug' : 'Debug'}
          </button>
        </div>

        {/* Mobile: compact status dot + hamburger */}
        <span className="socket-dot" data-status={status} title={status} />
        <button
          className="hamburger-btn"
          onClick={() => setMenuOpen(v => !v)}
          aria-label="Menu"
          aria-expanded={menuOpen}
        >
          {menuOpen ? '✕' : '☰'}
        </button>
      </header>

      {/* Mobile slide-down menu */}
      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <nav className="menu-drawer">
            <div className="menu-section">
              <span className="menu-label">Camera</span>
              {cameraSelector}
            </div>
            <div className="menu-section menu-status-row">
              <span className="socket-status" data-status={status}>{status}</span>
              <span className="freshness-badge" data-freshness={tl.semanticFreshness}>{tl.semanticFreshness}</span>
              <span className="playback-badge" data-state={tl.playbackState}>{tl.playbackState.replace(/_/g, ' ')}</span>
            </div>
            <div className="menu-section">
              <span className="slot-count">{tl.resolvedSlots.length}/60 · {typeBCount}B {tl.resolvedSlots.length - typeBCount}A</span>
            </div>
            <div className="menu-section">
              <button
                className="debug-toggle"
                onClick={() => { setShowDebug(v => !v); setMenuOpen(false); }}
              >
                {showDebug ? 'Hide Debug' : 'Show Debug'}
              </button>
            </div>
          </nav>
        </>
      )}
      <div className="app-body">
        <aside className="timeline-panel">
          <Timeline
            startTs={tl.startTs}
            endTs={tl.endTs}
            gaps={tl.timeline?.gaps ?? []}
            events={tl.timeline?.events ?? []}
            densityData={tl.density}
            cursorTs={tl.cursorTs}
            resolvedSlots={tl.resolvedSlots}
            slotDefs={tl.slotDefs}
            onSeek={handleSeek}
            onStepSlots={tl.onStepSlots}
            onPreviewRequest={tl.onPreviewRequest}
          />
          <ZoomControls
            rangeSec={tl.rangeSec}
            onZoomChange={tl.onZoomChange}
          />
        </aside>
        <main className="video-panel">
          <VideoPlayer
            camera={camera}
            playback={{ hls_url: tl.playbackUrl }}
            preview={tl.preview}
            playing={tl.playing}
            liveMode={tl.liveMode}
            loading={tl.loading}
            onPlay={tl.play}
            onPause={tl.pause}
            onTimeUpdate={tl.onVideoTimeUpdate}
          />

          {/* Playback controls */}
          <div className="playback-controls">
            {tl.playing ? (
              <button className="pb-btn" onClick={tl.pause}>Pause</button>
            ) : (
              <button className="pb-btn pb-play" onClick={tl.play}>Play Recording</button>
            )}
            {tl.cursorTs && (
              <span className="pb-time">
                {new Date(tl.cursorTs * 1000).toLocaleTimeString()}
              </span>
            )}
            {tl.isScrubbing && <span className="pb-scrubbing">Scrubbing...</span>}
          </div>

          {/* Slot grid */}
          <div className="resolved-slots-debug">
            <h3>Resolved Slots</h3>
            <div className="slot-grid">
              {tl.resolvedSlots.map((slot) => (
                <div
                  key={slot.slotIndex}
                  className={`slot-thumb ${slot.resolvedStrategy === 'B' ? 'slot-type-b' : ''} ${slot.status === 'dirty' ? 'slot-dirty' : ''}`}
                  onClick={() => tl.onSlotClick(slot)}
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

          {/* Debug overlay */}
          {showDebug && (
            <div className="debug-overlay">
              <h3>Debug</h3>
              <table className="debug-table">
                <tbody>
                  <tr><td>Camera</td><td>{camera}</td></tr>
                  <tr><td>Socket</td><td>{status}</td></tr>
                  <tr><td>Freshness</td><td>{tl.semanticFreshness}</td></tr>
                  <tr><td>Playback</td><td>{tl.playbackState}</td></tr>
                  <tr><td>Scrubbing</td><td>{tl.isScrubbing ? 'yes' : 'no'}</td></tr>
                  <tr><td>Cursor</td><td>{tl.cursorTs?.toFixed(2)}</td></tr>
                  <tr><td>Range</td><td>{tl.rangeSec}s ({(tl.rangeSec/60).toFixed(0)}m)</td></tr>
                  <tr><td>Viewport</td><td>{tl.startTs?.toFixed(0)} → {tl.endTs?.toFixed(0)}</td></tr>
                  <tr><td>Slots</td><td>{tl.resolvedSlots.length} total, {typeBCount} B, {tl.resolvedSlots.length - typeBCount} A</td></tr>
                  <tr><td>Playing</td><td>{tl.playing ? 'yes' : 'no'}</td></tr>
                  <tr><td>VOD URL</td><td className="debug-url">{tl.playbackUrl || 'none'}</td></tr>
                  <tr><td>Preview</td><td className="debug-url">{tl.preview || 'none'}</td></tr>
                </tbody>
              </table>
              {tl.resolvedSlots.length > 0 && (
                <>
                  <h4>Slot Detail (first 10)</h4>
                  <table className="debug-table debug-slot-table">
                    <thead>
                      <tr><th>#</th><th>Strategy</th><th>Score</th><th>Entity</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {tl.resolvedSlots.slice(0, 10).map(s => (
                        <tr key={s.slotIndex}>
                          <td>{s.slotIndex}</td>
                          <td className={s.resolvedStrategy === 'B' ? 'debug-b' : ''}>{s.resolvedStrategy}</td>
                          <td>{s.score != null ? (s.score * 100).toFixed(1) + '%' : '-'}</td>
                          <td className="debug-url">{s.winnerEntityId?.slice(-8) || '-'}</td>
                          <td>{s.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
