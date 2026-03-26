/**
 * Pure viewport math — no I/O, no side effects.
 *
 * A TimelineViewport describes the visible time window:
 *   tCursor   – the timestamp the user is focused on (center of the wheel)
 *   tNow      – wall-clock "now" at computation time
 *   tWheelMs  – total duration visible on the wheel, in ms
 *   cSlots    – number of time buckets the wheel is divided into
 *   tDivMs    – duration of one slot (tWheelMs / cSlots)
 *   tViewStart / tViewEnd – absolute bounds of the visible window
 */

export function buildViewport(tCursorMs, tNowMs, tWheelMs, cSlots = 60) {
  const tDivMs = tWheelMs / cSlots;
  const tViewStart = tCursorMs - tWheelMs / 2;
  const tViewEnd = tCursorMs + tWheelMs / 2;

  return {
    tCursor: tCursorMs,
    tNow: tNowMs,
    tWheelMs,
    cSlots,
    tDivMs,
    tViewStart,
    tViewEnd,
  };
}

/**
 * Zoom policy: choose preferred frame-resolution strategy based on wheel span.
 * At narrow zoom (≤ 2 min) use Type A (exact recording frames).
 * At wider zoom prefer Type B (semantic event snapshots).
 */
export function preferredStrategyForWheel(tWheelMs) {
  if (tWheelMs <= 2 * 60 * 1000) {
    return 'A';
  }
  return 'B';
}
