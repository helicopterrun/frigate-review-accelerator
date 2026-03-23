/**
 * Tests for snapToCoverage() — the binary-search helper that snaps a candidate
 * timestamp to the nearest covered position in the segments array.
 *
 * snapToCoverage is a module-scope function in App.jsx and is not exported, so
 * we test the logic directly here by duplicating the pure function.  Any change
 * to the implementation in App.jsx must be reflected here.
 *
 * Invariants under test:
 *   - ts inside a segment → returned unchanged
 *   - ts in a gap → snaps to nearer segment edge (both directions)
 *   - ts before all segments → snaps to first segment's start_ts
 *   - ts after all segments → snaps to last segment's end_ts
 *   - empty segments array → ts returned unchanged
 *   - null/undefined segments → ts returned unchanged
 */
import { describe, it, expect } from 'vitest';

// Mirror of App.jsx snapToCoverage — kept in sync by convention.
function snapToCoverage(ts, segments) {
  if (!segments?.length) return ts;
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (ts < seg.start_ts) hi = mid - 1;
    else if (ts > seg.end_ts) lo = mid + 1;
    else return ts; // inside a segment — no snap needed
  }
  // In a gap: lo = index of first segment after ts
  const prev = lo > 0 ? segments[lo - 1] : null;
  const next = lo < segments.length ? segments[lo] : null;
  if (!prev) return next.start_ts;
  if (!next) return prev.end_ts;
  return (ts - prev.end_ts) <= (next.start_ts - ts) ? prev.end_ts : next.start_ts;
}

// Minimal segment factory.
function seg(start_ts, end_ts) {
  return { start_ts, end_ts };
}

const SEGMENTS = [
  seg(100, 200),
  seg(300, 400),
  seg(600, 700),
];

describe('snapToCoverage — inside segment', () => {
  it('returns ts unchanged when ts is exactly at start_ts', () => {
    expect(snapToCoverage(100, SEGMENTS)).toBe(100);
  });

  it('returns ts unchanged when ts is exactly at end_ts', () => {
    expect(snapToCoverage(200, SEGMENTS)).toBe(200);
  });

  it('returns ts unchanged when ts is inside a segment', () => {
    expect(snapToCoverage(150, SEGMENTS)).toBe(150);
    expect(snapToCoverage(350, SEGMENTS)).toBe(350);
    expect(snapToCoverage(650, SEGMENTS)).toBe(650);
  });
});

describe('snapToCoverage — gap snapping', () => {
  it('snaps to prev.end_ts when closer to the previous segment', () => {
    // Gap between 200 and 300. ts=210 is 10 from prev.end and 90 from next.start
    expect(snapToCoverage(210, SEGMENTS)).toBe(200);
  });

  it('snaps to next.start_ts when closer to the next segment', () => {
    // Gap between 200 and 300. ts=290 is 90 from prev.end and 10 from next.start
    expect(snapToCoverage(290, SEGMENTS)).toBe(300);
  });

  it('snaps to prev.end_ts when equidistant (tie goes to prev)', () => {
    // Gap 200–300, midpoint 250: distance to prev.end = 50, to next.start = 50
    // Condition: (ts - prev.end_ts) <= (next.start_ts - ts) → 50 <= 50 → true → prev.end
    expect(snapToCoverage(250, SEGMENTS)).toBe(200);
  });

  it('snaps correctly in a later gap (400–600)', () => {
    // ts=410 is 10 from prev.end=400, 190 from next.start=600
    expect(snapToCoverage(410, SEGMENTS)).toBe(400);
    // ts=590 is 190 from prev.end=400, 10 from next.start=600
    expect(snapToCoverage(590, SEGMENTS)).toBe(600);
  });
});

describe('snapToCoverage — before all segments', () => {
  it('snaps to first segment start_ts when ts is before the first segment', () => {
    expect(snapToCoverage(50, SEGMENTS)).toBe(100);
    expect(snapToCoverage(0, SEGMENTS)).toBe(100);
  });
});

describe('snapToCoverage — after all segments', () => {
  it('snaps to last segment end_ts when ts is after the last segment', () => {
    expect(snapToCoverage(750, SEGMENTS)).toBe(700);
    expect(snapToCoverage(9999, SEGMENTS)).toBe(700);
  });
});

describe('snapToCoverage — empty / null inputs', () => {
  it('returns ts unchanged for an empty array', () => {
    expect(snapToCoverage(500, [])).toBe(500);
  });

  it('returns ts unchanged for null segments', () => {
    expect(snapToCoverage(500, null)).toBe(500);
  });

  it('returns ts unchanged for undefined segments', () => {
    expect(snapToCoverage(500, undefined)).toBe(500);
  });
});
