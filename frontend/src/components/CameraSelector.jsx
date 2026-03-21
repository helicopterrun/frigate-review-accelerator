/**
 * CameraSelector — single-camera select.
 *
 * Props:
 *   cameras   list[CameraInfo]
 *   selected  string | null
 *   onSelect  (name) => void
 *   isMobile  bool
 */

export default function CameraSelector({ cameras, selected, onSelect, isMobile = false }) {
  if (!cameras || cameras.length === 0) {
    return (
      <div style={{ color: '#888', fontSize: 17, padding: '8px 0' }}>
        No cameras indexed yet. Check backend health.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {!isMobile && <label style={{ color: '#aaa', fontSize: 17 }}>Camera:</label>}
      <select
        value={selected || ''}
        onChange={(e) => onSelect && onSelect(e.target.value)}
        style={{
          background: '#1a1d27',
          color: '#e0e0e0',
          border: '1px solid #333',
          borderRadius: 4,
          padding: '6px 12px',
          fontSize: isMobile ? 16 : 19,
          cursor: 'pointer',
          minWidth: isMobile ? undefined : 180,
          width: isMobile ? '100%' : undefined,
        }}
      >
        {cameras.map((cam) => (
          <option key={cam.name} value={cam.name}>{cam.name}</option>
        ))}
      </select>
    </div>
  );
}
