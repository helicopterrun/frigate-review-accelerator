"""Unit tests for the TimeIndex service."""

import pytest
import tempfile
from pathlib import Path


@pytest.fixture()
def idx(tmp_path, monkeypatch):
    """TimeIndex instance pointing at a temp preview dir."""
    from app import config
    monkeypatch.setattr(config.settings, "preview_output_path", tmp_path)
    monkeypatch.setattr(config.settings, "preview_interval_sec", 2)
    # Reset the singleton so it picks up monkeypatched settings
    import app.services.time_index as ti_mod
    ti_mod._time_index = None
    from app.services.time_index import TimeIndex
    return TimeIndex(preview_output_path=tmp_path, interval=2.0)


class TestBucketTs:
    def test_bucket_ts_alignment(self, idx):
        """1700000003.7 with interval=2 must snap to 1700000004.0"""
        assert idx.bucket_ts(1700000003.7) == pytest.approx(1700000004.0)

    def test_bucket_ts_globally_aligned(self, idx):
        """All results must be divisible by the interval."""
        timestamps = [1700000001.1, 1700000003.9, 1700000010.5, 1700000099.99]
        for ts in timestamps:
            result = idx.bucket_ts(ts)
            assert result % idx._interval == pytest.approx(0.0, abs=1e-9), (
                f"bucket_ts({ts}) = {result} is not aligned to interval={idx._interval}"
            )

    def test_exact_bucket_unchanged(self, idx):
        assert idx.bucket_ts(1700000004.0) == pytest.approx(1700000004.0)


class TestBucketPath:
    def test_bucket_path_filename_is_timestamp(self, idx):
        """Filename must be {ts:.2f}.jpg — this is the O(1) lookup invariant."""
        b = idx.bucket_ts(1700000003.7)  # → 1700000004.0
        path = idx.bucket_path("front-door", 1700000003.7)
        assert path.name == f"{b:.2f}.jpg"

    def test_bucket_path_exact_ts(self, idx):
        path = idx.bucket_path("front-door", 1700000004.0)
        assert path.name == "1700000004.00.jpg"

    def test_camera_in_path(self, idx):
        path = idx.bucket_path("alley-east", 1700000004.0)
        assert "alley-east" in str(path)

    def test_date_dir_in_path(self, idx):
        # 1700000004 = 2023-11-14 UTC
        path = idx.bucket_path("cam", 1700000004.0)
        parts = path.parts
        assert any(p.startswith("2023-") for p in parts)


class TestBucketExists:
    def test_bucket_exists_false_for_missing(self, idx):
        assert idx.bucket_exists("cam", 1700000004.0) is False

    def test_bucket_exists_true_for_present(self, idx, tmp_path):
        """Create the preview file and assert bucket_exists returns True."""
        from datetime import datetime, timezone
        b = idx.bucket_ts(1700000004.0)
        dt = datetime.fromtimestamp(b, tz=timezone.utc)
        date_dir = dt.strftime("%Y-%m-%d")
        preview_dir = tmp_path / "cam" / date_dir
        preview_dir.mkdir(parents=True, exist_ok=True)
        (preview_dir / f"{b:.2f}.jpg").write_bytes(b"fake")
        assert idx.bucket_exists("cam", 1700000004.0) is True


class TestEventDensity:
    def test_event_density_counts_correctly(self, idx):
        """One event at t=65 with interval auto-derived from 1h range → bucket_60 count=1"""

        class FakeEvent:
            def __init__(self, ts, label):
                self.start_ts = ts
                self.label = label

        events = [FakeEvent(65.0, "person")]
        # range = 0..3600 (1 hour) → bucket_sec = 60
        density = idx.event_density(events, range_start=0.0, range_end=3600.0)
        # bucket at t=60 (floor(65/60)*60 = 60)
        bucket_60 = next((d for d in density if d["ts"] == pytest.approx(60.0)), None)
        assert bucket_60 is not None, "Expected bucket at ts=60"
        assert bucket_60["count"] == 1
        assert bucket_60["labels"] == {"person": 1}

    def test_event_density_empty_events(self, idx):
        density = idx.event_density([], range_start=0.0, range_end=3600.0)
        # All buckets should have count=0
        assert all(d["count"] == 0 for d in density)


class TestAutoResolution:
    def test_auto_resolution_exact_thresholds(self):
        """Return values for documented boundary values must match the table exactly.

        Must stay in sync with bucketSizeForRange() in frontend/src/utils/time.js.
        """
        from app.services.time_index import TimeIndex
        assert TimeIndex.auto_resolution(1800) == 5    # ≤30m → 5s
        assert TimeIndex.auto_resolution(3600) == 5    # ≤1h  → 5s
        assert TimeIndex.auto_resolution(28800) == 15  # ≤8h  → 15s
        assert TimeIndex.auto_resolution(86400) == 60  # >8h  → 60s

    def test_auto_resolution_bucket_count_in_budget(self):
        """For each range, bucket count must fall within 50–2000.

        Budget relaxed from 900 to 2000: the density endpoint returns minimal
        per-bucket payloads (timestamp + counts), so 1920 buckets (8h/15s) is fine.
        """
        from app.services.time_index import TimeIndex
        ranges = [1800, 3600, 28800, 86400]
        for range_sec in ranges:
            res = TimeIndex.auto_resolution(range_sec)
            bucket_count = range_sec / res
            assert 50 <= bucket_count <= 2000, (
                f"range={range_sec}s, res={res}s → {bucket_count} buckets (out of budget)"
            )


class TestTimelineBuckets:
    """Tests for timeline_buckets — specifically the density alignment fix.

    The bug: event_density keyed events by floor(ts/bucket_sec)*bucket_sec,
    while the bucket loop looked up floor(b_start/bucket_sec)*bucket_sec where
    b_start = range_start + i*bucket_sec.  When range_start is not a multiple
    of bucket_sec these two key series diverge, causing events near bucket
    boundaries to be attributed to the wrong logical bucket.

    The fix computes density inline using b_start/b_end overlap, so keys
    always match the logical bucket series regardless of range_start alignment.
    """

    class FakeEvent:
        def __init__(self, start_ts, end_ts=None, label="person"):
            self.start_ts = start_ts
            self.end_ts = end_ts
            self.label = label

    def test_first_bucket_not_zero_when_event_crosses_global_boundary(self, idx):
        """Event at t=1050 falls in logical bucket [995,1055) but in a different
        global-aligned 60s bucket than range_start=995.  Must appear in bucket 0,
        not bucket 1."""
        # Use explicit end_ts so spans stay within bucket 0 [995,1055)
        events = [
            self.FakeEvent(1000.0, end_ts=1001.0),
            self.FakeEvent(1050.0, end_ts=1051.0),
        ]
        # range_dur=120, resolution=2 → bucket_sec=60
        # Logical bucket 0: [995, 1055), bucket 1: [1055, 1115)
        buckets = idx.timeline_buckets(
            range_start=995.0,
            range_end=1115.0,
            camera="cam",
            events=events,
            resolution=2,
            preview_ts_set=set(),
        )
        assert len(buckets) == 2
        assert buckets[0]["event_density"] >= 1, (
            "Bucket 0 must count events in [995,1055); got 0"
        )
        # Both events fall within bucket 0; bucket 1 should be empty
        assert buckets[0]["event_density"] == 2
        assert buckets[1]["event_density"] == 0

    def test_density_correct_for_unaligned_range_start(self, idx):
        """Density must be correct when range_start is an arbitrary Unix timestamp
        (the common case — real timestamps are never multiples of bucket_sec)."""
        events = [self.FakeEvent(1001.0)]
        # range_start=999 is not a multiple of bucket_sec=60
        buckets = idx.timeline_buckets(
            range_start=999.0,
            range_end=1119.0,
            camera="cam",
            events=events,
            resolution=2,
            preview_ts_set=set(),
        )
        # Event at 1001 falls in bucket 0 [999, 1059)
        assert buckets[0]["event_density"] == 1
        assert buckets[1]["event_density"] == 0

    def test_event_in_second_bucket_not_leaked_into_first(self, idx):
        """An event in bucket 1 must not bleed into bucket 0."""
        events = [self.FakeEvent(1060.0)]
        buckets = idx.timeline_buckets(
            range_start=995.0,
            range_end=1115.0,
            camera="cam",
            events=events,
            resolution=2,
            preview_ts_set=set(),
        )
        assert buckets[0]["event_density"] == 0
        assert buckets[1]["event_density"] == 1

    def test_no_events_all_zero(self, idx):
        buckets = idx.timeline_buckets(
            range_start=995.0,
            range_end=1115.0,
            camera="cam",
            events=[],
            resolution=2,
            preview_ts_set=set(),
        )
        assert all(b["event_density"] == 0 for b in buckets)


class TestGetTimeIndexSingleton:
    def test_get_time_index_singleton(self, monkeypatch, tmp_path):
        """Two calls to get_time_index() must return the same object."""
        from app import config
        monkeypatch.setattr(config.settings, "preview_output_path", tmp_path)
        import app.services.time_index as ti_mod
        ti_mod._time_index = None  # reset
        from app.services.time_index import get_time_index
        a = get_time_index()
        b = get_time_index()
        assert a is b
