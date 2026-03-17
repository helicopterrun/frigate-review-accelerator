/**
 * CameraSelector — dropdown for switching between indexed cameras.
 */

export default function CameraSelector({ cameras, selected, onSelect }) {
  if (!cameras || cameras.length === 0) {
    return (
      <div style={{ color: '#888', fontSize: 13, padding: '8px 0' }}>
        No cameras indexed yet. Check backend health.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ color: '#aaa', fontSize: 13 }}>Camera:</label>
      <select
        value={selected || ''}
        onChange={(e) => onSelect(e.target.value)}
        style={{
          background: '#1a1d27',
          color: '#e0e0e0',
          border: '1px solid #333',
          borderRadius: 4,
          padding: '6px 12px',
          fontSize: 14,
          cursor: 'pointer',
          minWidth: 180,
        }}
      >
        {cameras.map((cam) => (
          <option key={cam.name} value={cam.name}>
            {cam.name} ({cam.segment_count} segs · {cam.preview_count} frames)
          </option>
        ))}
      </select>
    </div>
  );
}
