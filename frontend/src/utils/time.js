/**
 * Time formatting and conversion utilities.
 */

/** Format a Unix timestamp as HH:MM:SS */
export function formatTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/** Format a Unix timestamp as HH:MM */
export function formatTimeShort(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/** Format a Unix timestamp as YYYY-MM-DD */
export function formatDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-CA'); // ISO format
}

/** Format a Unix timestamp as YYYY-MM-DD HH:MM:SS */
export function formatDateTime(ts) {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

/** Format duration in seconds as M:SS or H:MM:SS */
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Get the start of today (midnight) as Unix timestamp.
 * Used as default timeline range.
 */
export function todayStartTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** Get current time as Unix timestamp. */
export function nowTs() {
  return Date.now() / 1000;
}

/**
 * Clamp a timestamp to a range.
 */
export function clampTs(ts, min, max) {
  return Math.min(Math.max(ts, min), max);
}
