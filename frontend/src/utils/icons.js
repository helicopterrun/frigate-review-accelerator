/**
 * Shared icon utilities for Timeline and VerticalTimeline canvas rendering.
 *
 * ICON_PATHS — Lucide SVG path data keyed by Frigate event label.
 *   Unlisted labels ("face", "fire", "license_plate", etc.) silently produce
 *   no icon — no text fallback, no placeholder, no console warning.
 *
 * buildIconCanvas — render a single SVG icon to an offscreen canvas.
 *
 * buildIconCache — construct a Map<label, HTMLCanvasElement> for a full label
 *   set. Accepts a callback that fires once all async SVG→Image loads complete,
 *   enabling each canvas component to schedule a final repaint.
 *
 * TODO: add frontend test — ICON_CACHE populated at module init,
 * unknown labels ("face", "fire", "license_plate") produce no icon and no
 * console warning.
 */

export const ICON_PATHS = {
  person:     `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  car:        `<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>`,
  truck:      `<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>`,
  motorcycle: `<path d="m18 14-1-3"/><path d="m3 9 6 2a2 2 0 0 1 2-2h2a2 2 0 0 1 1.99 1.81"/><path d="M8 17h3a1 1 0 0 0 1-1 6 6 0 0 1 6-6 1 1 0 0 0 1-1v-.75A5 5 0 0 0 17 5"/><circle cx="19" cy="17" r="3"/><circle cx="5" cy="17" r="3"/>`,
  bicycle:    `<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>`,
  dog:        `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  cat:        `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  bird:       `<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/>`,
  horse:      `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  bear:       `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  deer:       `<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>`,
  package:    `<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>`,
};

/**
 * Render a single Lucide SVG icon into an offscreen 12×12 canvas.
 *
 * The canvas is returned immediately (blank until the async SVG→Image load
 * fires). Call onLoad to be notified when the pixel data is ready.
 */
export function buildIconCanvas(svgPathData, color, size = 12, onLoad = null) {
  const oc = document.createElement('canvas');
  oc.width = size;
  oc.height = size;
  const ctx = oc.getContext('2d');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPathData}</svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    if (onLoad) onLoad();
  };
  return oc;
}

/**
 * Build a Map<label, HTMLCanvasElement> for a full icon set.
 *
 * @param {Object} iconPaths  - ICON_PATHS (or a subset)
 * @param {Function} getColor - (label: string) => CSS color string
 * @param {Function} onAllLoaded - called once when all async loads complete
 * @returns {Map<string, HTMLCanvasElement>}
 */
export function buildIconCache(iconPaths, getColor, onAllLoaded) {
  const cache = new Map();
  let loaded = 0;
  const target = Object.keys(iconPaths).length;
  for (const [label, pathData] of Object.entries(iconPaths)) {
    cache.set(label, buildIconCanvas(pathData, getColor(label), 12, () => {
      loaded++;
      if (loaded >= target) onAllLoaded();
    }));
  }
  return cache;
}
