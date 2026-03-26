import { useState, useEffect } from 'react';
import { fetchCameras } from '../api/client.js';

export default function CameraSelector({ selected, onSelect }) {
  const [cameras, setCameras] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCameras()
      .then(data => {
        const list = Array.isArray(data) ? data : data.cameras ?? [];
        setCameras(list);
        if (!selected && list.length > 0) {
          const name = typeof list[0] === 'string' ? list[0] : list[0].name;
          onSelect(name);
        }
      })
      .catch(err => setError(err.message));
  }, []);

  if (error) return <div className="camera-selector error">Failed to load cameras: {error}</div>;
  if (cameras.length === 0) return <div className="camera-selector">Loading cameras...</div>;

  return (
    <div className="camera-selector">
      {cameras.map(cam => {
        const name = typeof cam === 'string' ? cam : cam.name;
        const active = name === selected;
        return (
          <button
            key={name}
            className={`cam-btn${active ? ' active' : ''}`}
            onClick={() => onSelect(name)}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
