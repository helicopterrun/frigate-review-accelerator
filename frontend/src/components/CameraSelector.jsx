/**
 * CameraSelector — single select or multi-select for split view.
 *
 * Props:
 *   cameras       list[CameraInfo]
 *   selected      string | null           (single mode)
 *   selectedMany  string[]                (multi mode)
 *   onSelect      (name) => void          (single mode)
 *   onSelectMany  (names) => void         (multi mode)
 *   multiMode     bool — show checkboxes for split view
 *   maxSelect     int  — max cameras in multi mode (default 4)
 */

export default function CameraSelector({
  cameras,
  selected,
  selectedMany = [],
  onSelect,
  onSelectMany,
  multiMode = false,
  maxSelect = 4,
  isMobile = false,
}) {
  if (!cameras || cameras.length === 0) {
    return (
      <div style={{ color: '#888', fontSize: 17, padding: '8px 0' }}>
        No cameras indexed yet. Check backend health.
      </div>
    );
  }

  if (!multiMode) {
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
            <option key={cam.name} value={cam.name}>
              {isMobile
                ? cam.name
                : `${cam.name} (${cam.segment_count} segs · ${cam.preview_count} frames)`}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Multi-select (split view)
  function toggleCamera(name) {
    if (!onSelectMany) return;
    const isSelected = selectedMany.includes(name);
    if (isSelected) {
      onSelectMany(selectedMany.filter((n) => n !== name));
    } else if (selectedMany.length < maxSelect) {
      onSelectMany([...selectedMany, name]);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <label style={{ color: '#aaa', fontSize: 17 }}>Cameras:</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {cameras.map((cam) => {
          const checked = selectedMany.includes(cam.name);
          const disabled = !checked && selectedMany.length >= maxSelect;
          return (
            <label
              key={cam.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: checked ? '#1e3a5a' : '#1a1d27',
                border: `1px solid ${checked ? '#2196F3' : '#333'}`,
                borderRadius: 4,
                padding: '4px 10px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : 1,
                fontSize: 17,
                color: checked ? '#e0e0e0' : '#888',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleCamera(cam.name)}
                style={{ margin: 0 }}
              />
              {cam.name}
            </label>
          );
        })}
      </div>
      {selectedMany.length > 0 && (
        <span style={{ color: '#555', fontSize: 15 }}>
          {selectedMany.length}/{maxSelect} selected
        </span>
      )}
    </div>
  );
}
