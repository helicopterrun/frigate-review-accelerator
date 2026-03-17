/**
 * API client for the Accelerator backend.
 *
 * All fetch calls go through the Vite proxy (/api → localhost:8100).
 */

const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

/** GET /api/cameras */
export async function fetchCameras() {
  return apiFetch('/cameras');
}

/** GET /api/timeline?camera=X&start=Y&end=Z */
export async function fetchTimeline(camera, startTs, endTs) {
  const params = new URLSearchParams({
    camera,
    start: String(startTs),
    end: String(endTs),
  });
  return apiFetch(`/timeline?${params}`);
}

/** GET /api/preview-strip/{camera}?start=X&end=Y&max_frames=N */
export async function fetchPreviewStrip(camera, startTs, endTs, maxFrames = 300) {
  const params = new URLSearchParams({
    start: String(startTs),
    end: String(endTs),
    max_frames: String(maxFrames),
  });
  return apiFetch(`/preview-strip/${camera}?${params}`);
}

/**
 * GET /api/playback?camera=X&ts=Y
 *
 * Backend resolves timestamp → segment + offset.
 * Returns: { segment_id, offset_sec, stream_url, next_segment_id, ... }
 */
export async function fetchPlaybackTarget(camera, ts) {
  const params = new URLSearchParams({
    camera,
    ts: String(ts),
  });
  return apiFetch(`/playback?${params}`);
}

/**
 * Build the URL for a single preview frame.
 * Used directly in <img> src for scrubbing — no fetch() needed.
 */
export function previewFrameUrl(camera, timestamp) {
  return `${API_BASE}/preview/${camera}/${timestamp}`;
}

/**
 * Build the URL for streaming a segment MP4.
 * Prefer using fetchPlaybackTarget() which returns this pre-built.
 */
export function segmentStreamUrl(segmentId, offsetSec) {
  const base = `${API_BASE}/segment/${segmentId}/stream`;
  if (offsetSec != null && offsetSec > 0) {
    return `${base}#t=${offsetSec.toFixed(2)}`;
  }
  return base;
}

/** GET /api/health */
export async function fetchHealth() {
  return apiFetch('/health');
}

/** POST /api/index/scan */
export async function triggerScan() {
  return apiFetch('/index/scan', { method: 'POST' });
}

/** GET /api/preview/stats */
export async function fetchCacheStats() {
  return apiFetch('/preview/stats');
}
