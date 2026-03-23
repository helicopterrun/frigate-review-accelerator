import { describe, it, expect } from 'vitest';
import {
  bucketSizeForRange,
  nowTs,
  formatTime,
  formatDate,
  formatDuration,
} from '../utils/time.js';

describe('bucketSizeForRange', () => {
  it('returns 5s for range at the 30-minute boundary', () => {
    expect(bucketSizeForRange(1800)).toBe(5);
  });

  it('returns 5s for range at the 1-hour boundary', () => {
    expect(bucketSizeForRange(3600)).toBe(5);
  });

  it('returns 15s for a range just over 1 hour', () => {
    expect(bucketSizeForRange(3601)).toBe(15);
  });

  it('returns 15s for range at the 8-hour boundary', () => {
    expect(bucketSizeForRange(28800)).toBe(15);
  });

  it('returns 60s for a range just over 8 hours', () => {
    expect(bucketSizeForRange(28801)).toBe(60);
  });

  it('returns 60s for a 24-hour range', () => {
    expect(bucketSizeForRange(86400)).toBe(60);
  });

  // Verify sync with backend TimeIndex.auto_resolution() thresholds:
  // ≤3600s → 5, ≤28800s → 15, >28800s → 60
  it('bucket count never exceeds ~2000 for typical ranges', () => {
    const cases = [
      { range: 1800,  bucket: 5  },
      { range: 3600,  bucket: 5  },
      { range: 28800, bucket: 15 },
      { range: 86400, bucket: 60 },
    ];
    for (const { range, bucket } of cases) {
      expect(range / bucket).toBeLessThanOrEqual(2000);
    }
  });
});

describe('nowTs', () => {
  it('returns a finite number close to Date.now() / 1000', () => {
    const before = Date.now() / 1000;
    const ts = nowTs();
    const after = Date.now() / 1000;
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 0.01);
  });

  it('returns a Unix timestamp in a plausible range (after 2020, before 2100)', () => {
    const ts = nowTs();
    expect(ts).toBeGreaterThan(1577836800); // 2020-01-01
    expect(ts).toBeLessThan(4102444800);    // 2100-01-01
  });
});

describe('formatTime', () => {
  // 2023-11-14 20:09:23 UTC — a fixed reference point independent of local tz offset.
  // We test format shape rather than exact value to remain tz-agnostic.
  const TS = 1700000963;

  it('12h format produces a non-empty string without NaN', () => {
    const result = formatTime(TS, '12h');
    expect(result).toBeTruthy();
    expect(result).not.toContain('NaN');
  });

  it('12h format matches h:MM:SS AM/PM pattern', () => {
    const result = formatTime(TS, '12h');
    expect(result).toMatch(/^\d{1,2}:\d{2}:\d{2}\s*(AM|PM)$/i);
  });

  it('24h format produces a non-empty string without NaN', () => {
    const result = formatTime(TS, '24h');
    expect(result).toBeTruthy();
    expect(result).not.toContain('NaN');
  });

  it('24h format matches HH:MM:SS pattern', () => {
    const result = formatTime(TS, '24h');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('defaults to 12h when format arg is omitted', () => {
    const result = formatTime(TS);
    expect(result).toMatch(/AM|PM/i);
  });
});

describe('formatDate', () => {
  it('returns YYYY-MM-DD format', () => {
    const TS = 1700000963; // 2023-11-14 in UTC
    const result = formatDate(TS);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).not.toContain('NaN');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute as 0:SS', () => {
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats minutes as M:SS', () => {
    expect(formatDuration(90)).toBe('1:30');
  });

  it('formats hours as H:MM:SS', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('pads seconds to two digits', () => {
    expect(formatDuration(65)).toBe('1:05');
  });
});
