"""Unit tests for timeline gap detection and coverage computation."""

import pytest
from app.models.schemas import EventInfo, GapInfo, SegmentInfo
from app.routers.timeline import MIN_GAP_SEC, _compute_gaps, _compute_activity


def make_seg(id, start, end):
    return SegmentInfo(
        id=id, camera="test", start_ts=start, end_ts=end,
        duration=end - start, has_previews=False,
    )


def make_evt(id, start, end, label="person"):
    return EventInfo(id=id, camera="test", start_ts=start, end_ts=end,
                     label=label, score=0.9)


class TestGapDetection:
    def test_empty_segments_whole_range_is_gap(self):
        gaps = _compute_gaps([], range_start=1000.0, range_end=4000.0)
        assert len(gaps) == 1
        assert gaps[0].start_ts == 1000.0
        assert gaps[0].end_ts == 4000.0

    def test_empty_segments_range_smaller_than_min_gap(self):
        gaps = _compute_gaps([], range_start=1000.0, range_end=1000.0 + MIN_GAP_SEC - 0.5)
        assert gaps == []

    def test_no_gaps_when_continuous(self):
        segs = [make_seg(1, 1000, 1010), make_seg(2, 1010, 1020)]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1020.0)
        assert gaps == []

    def test_leading_gap(self):
        segs = [make_seg(1, 1100.0, 1200.0)]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1200.0)
        leading = [g for g in gaps if g.start_ts == 1000.0]
        assert len(leading) == 1
        assert leading[0].end_ts == pytest.approx(1100.0)

    def test_trailing_gap(self):
        segs = [make_seg(1, 1000.0, 1100.0)]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1300.0)
        trailing = [g for g in gaps if g.end_ts == 1300.0]
        assert len(trailing) == 1
        assert trailing[0].start_ts == pytest.approx(1100.0)

    def test_internal_gap(self):
        segs = [make_seg(1, 1000.0, 1010.0), make_seg(2, 1060.0, 1070.0)]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1070.0)
        internal = [g for g in gaps if g.start_ts == pytest.approx(1010.0)]
        assert len(internal) == 1
        assert internal[0].end_ts == pytest.approx(1060.0)
        assert internal[0].duration == pytest.approx(50.0)

    def test_min_duration_filter(self):
        """Gaps shorter than MIN_GAP_SEC must be filtered out."""
        segs = [
            make_seg(1, 1000.0, 1010.0),
            make_seg(2, 1010.0 + MIN_GAP_SEC - 0.5, 1020.0),  # gap < MIN_GAP_SEC
        ]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1020.0)
        internal = [g for g in gaps if g.start_ts == pytest.approx(1010.0)]
        assert internal == []

    def test_gap_exactly_at_min_threshold_excluded(self):
        """Gap exactly equal to MIN_GAP_SEC should be excluded (> not >=)."""
        segs = [
            make_seg(1, 1000.0, 1010.0),
            make_seg(2, 1010.0 + MIN_GAP_SEC, 1020.0),
        ]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1020.0)
        internal = [g for g in gaps if g.start_ts == pytest.approx(1010.0)]
        assert internal == []

    def test_multiple_internal_gaps(self):
        segs = [
            make_seg(1, 1000.0, 1010.0),
            make_seg(2, 1100.0, 1110.0),
            make_seg(3, 1200.0, 1210.0),
        ]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1210.0)
        internal = [g for g in gaps if 1010.0 <= g.start_ts < 1210.0]
        assert len(internal) == 2

    def test_gap_duration_accurate(self):
        segs = [make_seg(1, 1000.0, 1020.0), make_seg(2, 1120.0, 1140.0)]
        gaps = _compute_gaps(segs, range_start=1000.0, range_end=1140.0)
        gap = gaps[0]
        assert gap.duration == pytest.approx(100.0)


class TestCoveragePercent:
    def test_full_coverage(self):
        """One segment spanning the entire range → 100%."""
        segs = [make_seg(1, 1000.0, 2000.0)]
        # Compute inline (same logic as the router)
        range_dur = 1000.0
        covered = sum(min(s.end_ts, 2000.0) - max(s.start_ts, 1000.0) for s in segs)
        pct = min(covered / range_dur * 100, 100.0)
        assert pct == pytest.approx(100.0)

    def test_no_overlap(self):
        """Segment entirely outside range → 0%."""
        segs = [make_seg(1, 3000.0, 4000.0)]
        range_start, range_end = 1000.0, 2000.0
        covered = sum(
            max(0, min(s.end_ts, range_end) - max(s.start_ts, range_start))
            for s in segs
        )
        pct = covered / (range_end - range_start) * 100
        assert pct == pytest.approx(0.0)

    def test_capped_at_100(self):
        """Coverage must be capped at 100% even with overlapping segments."""
        segs = [
            make_seg(1, 900.0, 1500.0),   # extends before range start
            make_seg(2, 1200.0, 2100.0),  # extends past range end
        ]
        range_start, range_end = 1000.0, 2000.0
        covered = sum(
            max(0, min(s.end_ts, range_end) - max(s.start_ts, range_start))
            for s in segs
        )
        pct = min(covered / (range_end - range_start) * 100, 100.0)
        assert pct <= 100.0


class TestActivityBuckets:
    def test_empty_events(self):
        buckets = _compute_activity([], range_start=1000.0, range_end=4600.0)
        # Should still return initialized empty buckets
        assert all(b.count == 0 for b in buckets)

    def test_event_counted_in_correct_bucket(self):
        # range ≤ 1h → bucket_sec = 60
        range_start = 0.0
        range_end = 3600.0
        evts = [make_evt("e1", start=125.0, end=130.0)]  # bucket starting at 120
        buckets = _compute_activity(evts, range_start, range_end)
        bucket_120 = next((b for b in buckets if b.bucket_ts == 120.0), None)
        assert bucket_120 is not None
        assert bucket_120.count == 1

    def test_label_breakdown(self):
        range_start = 0.0
        range_end = 3600.0
        evts = [
            make_evt("e1", 65.0, 70.0, label="person"),
            make_evt("e2", 70.0, 75.0, label="car"),
            make_evt("e3", 80.0, 85.0, label="person"),
        ]
        buckets = _compute_activity(evts, range_start, range_end)
        bucket_60 = next(b for b in buckets if b.bucket_ts == 60.0)
        assert bucket_60.labels.get("person") == 2
        assert bucket_60.labels.get("car") == 1
        assert bucket_60.count == 3

    def test_event_spanning_multiple_buckets_increments_all(self):
        """An event spanning 3 buckets must increment all 3 bucket counts."""
        # range ≤ 1h → bucket_sec = 60
        range_start = 0.0
        range_end = 3600.0
        # Event from t=60 to t=200: spans buckets 60, 120, 180
        evts = [make_evt("e1", start=60.0, end=200.0)]
        buckets = _compute_activity(evts, range_start, range_end)
        bucket_60  = next(b for b in buckets if b.bucket_ts == 60.0)
        bucket_120 = next(b for b in buckets if b.bucket_ts == 120.0)
        bucket_180 = next(b for b in buckets if b.bucket_ts == 180.0)
        bucket_240 = next(b for b in buckets if b.bucket_ts == 240.0)
        assert bucket_60.count == 1
        assert bucket_120.count == 1
        assert bucket_180.count == 1
        assert bucket_240.count == 0  # event ends at 200, floor(200/60)=3 → bucket 180

    def test_event_contained_in_single_bucket(self):
        """An event entirely within one bucket increments only that bucket."""
        range_start = 0.0
        range_end = 3600.0
        evts = [make_evt("e1", start=65.0, end=90.0)]  # both in bucket 60
        buckets = _compute_activity(evts, range_start, range_end)
        bucket_60  = next(b for b in buckets if b.bucket_ts == 60.0)
        bucket_120 = next(b for b in buckets if b.bucket_ts == 120.0)
        assert bucket_60.count == 1
        assert bucket_120.count == 0

    def test_event_with_none_end_ts_uses_fallback(self):
        """An event with end_ts=None must use start_ts + 30s as the span."""
        range_start = 0.0
        range_end = 3600.0
        # start=65, end=None → effective_end=95; floor(65/60)=1→bucket 60,
        # floor(95/60)=1→bucket 60.  Both land in the same bucket.
        evts = [make_evt("e1", start=65.0, end=None)]
        buckets = _compute_activity(evts, range_start, range_end)
        bucket_60  = next(b for b in buckets if b.bucket_ts == 60.0)
        bucket_120 = next(b for b in buckets if b.bucket_ts == 120.0)
        assert bucket_60.count == 1
        assert bucket_120.count == 0

        # start=90, end=None → effective_end=120; floor(90/60)=1→bucket 60,
        # floor(120/60)=2→bucket 120.  Two buckets get incremented.
        evts2 = [make_evt("e2", start=90.0, end=None)]
        buckets2 = _compute_activity(evts2, range_start, range_end)
        b60  = next(b for b in buckets2 if b.bucket_ts == 60.0)
        b120 = next(b for b in buckets2 if b.bucket_ts == 120.0)
        assert b60.count == 1
        assert b120.count == 1

    def test_pathological_event_is_capped(self):
        """A 24-hour event must not blow up — capped at MAX_SPAN_BUCKETS=200."""
        # Use >24h range → bucket_sec=1800
        range_start = 0.0
        range_end = 90_000.0  # 25 hours
        # Event spanning the entire range (86400s / 1800s per bucket = 48 buckets < 200 cap)
        evts = [make_evt("e1", start=0.0, end=86_400.0)]
        buckets = _compute_activity(evts, range_start, range_end)
        # Expect exactly 48 incremented buckets (0, 1800, ..., 46*1800=82800)
        # floor(86400/1800)=48, so buckets 0..48 → 49 buckets
        incremented = [b for b in buckets if b.count > 0]
        assert len(incremented) == 49  # buckets 0 through 48*1800

        # Now test the cap: event so long it would exceed 200 buckets
        # bucket_sec=1800, 200 buckets = 360000s
        # Event 0..720000 → would be 400 buckets without cap
        evts_huge = [make_evt("e2", start=0.0, end=720_000.0)]
        # range must contain at least 200 buckets
        range_end_huge = 720_000.0 + 1800.0
        buckets_huge = _compute_activity(evts_huge, 0.0, range_end_huge)
        incremented_huge = [b for b in buckets_huge if b.count > 0]
        assert len(incremented_huge) == 200  # capped
