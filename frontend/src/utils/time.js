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

/**
 * Select bucket size (seconds) for a given visible range.
 *
 * Aligned with Frigate tracked object durations (typically 5-60s).
 * Minimum 5s to avoid oversampling the same event across many buckets.
 * Keeps bucket count under ~2000 for any range.
 *
 * Must stay in sync with TimeIndex.auto_resolution() in
 * backend/app/services/time_index.py.
 *
 * TODO: add unit tests verifying sync with TimeIndex.auto_resolution().
 *
 * @param {number} rangeSec - visible time range in seconds
 * @returns {number} bucket size in seconds
 */
export function bucketSizeForRange(rangeSec) {
  if (rangeSec <= 1800)  return 5;   // ≤30m → 5s  (max  360 buckets)
  if (rangeSec <= 3600)  return 5;   // ≤1h  → 5s  (max  720 buckets)
  if (rangeSec <= 28800) return 15;  // ≤8h  → 15s (max 1920 buckets)
  return 60;                          // >8h  → 60s (max ~1440 at 24h)
}
