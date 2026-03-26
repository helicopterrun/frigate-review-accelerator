export function clampTs(ts, min, max) {
  return Math.max(min, Math.min(max, ts));
}

export function formatHHMM(ts, fmt) {
  const d = new Date(ts * 1000);
  const h24 = d.getHours();
  const h = fmt === '12h' ? (h24 % 12 || 12) : h24;
  return `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function parseTs(ts, fmt) {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  const h24 = d.getHours();
  return {
    hours:   fmt === '12h' ? String(h24 % 12 || 12).padStart(2, '0') : String(h24).padStart(2, '0'),
    minutes: String(d.getMinutes()).padStart(2, '0'),
    seconds: String(d.getSeconds()).padStart(2, '0'),
    isPM:    h24 >= 12,
    is12h:   fmt === '12h',
  };
}

export function nearestZoomIdx(rangeSec, stops) {
  let best = 0, bestDiff = Math.abs(stops[0] - rangeSec);
  for (let i = 1; i < stops.length; i++) {
    const d = Math.abs(stops[i] - rangeSec);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}
