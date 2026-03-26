import { ZOOM_PRESETS, ZOOM_STOPS, ZOOM_STOP_LABELS } from '../utils/constants.js';
import { nearestZoomIdx } from '../utils/time.js';

export default function ZoomControls({ rangeSec, onZoomChange, isMobile = false }) {
  const zoomIdx = nearestZoomIdx(rangeSec, ZOOM_STOPS);

  const applyZoom = (idx) => {
    const c = Math.max(0, Math.min(ZOOM_STOPS.length - 1, idx));
    onZoomChange(ZOOM_STOPS[c]);
  };

  return (
    <div className="zoom-controls">
      <div className="zoom-presets">
        {ZOOM_PRESETS.map(p => {
          const active = Math.abs(rangeSec - p.sec) <= p.sec * 0.05;
          return (
            <button
              key={p.label}
              className={`zoom-btn${active ? ' active' : ''}`}
              onClick={() => onZoomChange(p.sec)}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="zoom-slider">
        <button
          className="zoom-step"
          onClick={() => applyZoom(zoomIdx + 1)}
          disabled={zoomIdx >= ZOOM_STOPS.length - 1}
          style={{ width: isMobile ? 36 : 28, height: isMobile ? 36 : 28 }}
        >
          -
        </button>
        <input
          type="range"
          min={0}
          max={ZOOM_STOPS.length - 1}
          value={zoomIdx}
          onChange={e => applyZoom(Number(e.target.value))}
        />
        <span className="zoom-label">{ZOOM_STOP_LABELS[zoomIdx]}</span>
        <button
          className="zoom-step"
          onClick={() => applyZoom(zoomIdx - 1)}
          disabled={zoomIdx <= 0}
          style={{ width: isMobile ? 36 : 28, height: isMobile ? 36 : 28 }}
        >
          +
        </button>
      </div>
    </div>
  );
}
