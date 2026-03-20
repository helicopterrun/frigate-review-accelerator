"""Unit tests for TimeIndex.compute_density_buckets()."""

import pytest
from app.services.time_index import TimeIndex


@pytest.fixture()
def idx():
    """TimeIndex instance with default settings (interval irrelevant here)."""
    from pathlib import Path
    return TimeIndex(preview_output_path=Path("/tmp"), interval=2.0)


class TestComputeDensityBuckets:
    def test_single_event_in_one_bucket(self, idx):
        """Event wholly within one bucket is counted only in that bucket."""
        events = [{"start_ts": 10.0, "end_ts": 20.0, "label": "person"}]
        buckets = idx.compute_density_buckets(events, 0.0, 60.0, 30)
        assert buckets[0]["total"] == 1  # bucket [0, 30)
        assert buckets[1]["total"] == 0  # bucket [30, 60)

    def test_single_event_counted_in_overlapping_buckets(self, idx):
        """Event spanning 3 buckets must appear in all 3."""
        # Buckets: [0,10), [10,20), [20,30) — event covers all three
        events = [{"start_ts": 5.0, "end_ts": 25.0, "label": "car"}]
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 10)
        assert len(buckets) == 3
        assert buckets[0]["total"] == 1
        assert buckets[1]["total"] == 1
        assert buckets[2]["total"] == 1

    def test_empty_range_returns_empty_buckets(self, idx):
        """All buckets have total=0 when no events exist."""
        buckets = idx.compute_density_buckets([], 0.0, 60.0, 15)
        assert all(b["total"] == 0 for b in buckets)
        assert all(b["counts"] == {} for b in buckets)

    def test_importance_flag_set_for_important_labels(self, idx):
        """Bucket with a 'cat' event → important=True."""
        events = [{"start_ts": 5.0, "end_ts": 8.0, "label": "cat"}]
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 15)
        assert buckets[0]["important"] is True
        assert buckets[1]["important"] is False

    def test_importance_flag_false_for_normal_labels(self, idx):
        """Bucket with only 'person' events → important=False."""
        events = [{"start_ts": 5.0, "end_ts": 8.0, "label": "person"}]
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 15)
        assert all(not b["important"] for b in buckets)

    def test_custom_importance_fn(self, idx):
        """Custom importance_fn overrides the default label-based predicate."""
        events = [{"start_ts": 5.0, "end_ts": 8.0, "label": "person"}]
        buckets = idx.compute_density_buckets(
            events, 0.0, 15.0, 15, importance_fn=lambda evt: evt["label"] == "person"
        )
        assert buckets[0]["important"] is True

    def test_custom_importance_fn_false(self, idx):
        """Custom importance_fn returning False leaves bucket non-important."""
        events = [{"start_ts": 5.0, "end_ts": 8.0, "label": "cat"}]
        # Even though 'cat' is in the default set, a custom fn overrides
        buckets = idx.compute_density_buckets(
            events, 0.0, 15.0, 15, importance_fn=lambda evt: evt["label"] == "person"
        )
        assert buckets[0]["important"] is False

    def test_active_event_no_end_time(self, idx):
        """Event with end_ts=None uses 5s fallback duration."""
        # Active event at t=5 with no end — fallback end=10
        events = [{"start_ts": 5.0, "end_ts": None, "label": "person"}]
        # Bucket [0, 30) should see the event (5..10 overlaps 0..30)
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 30)
        assert buckets[0]["total"] == 1

    def test_counts_per_label_correct(self, idx):
        """2 person + 1 car in bucket → counts={person:2, car:1}, total=3."""
        events = [
            {"start_ts": 5.0,  "end_ts": 8.0,  "label": "person"},
            {"start_ts": 10.0, "end_ts": 12.0, "label": "person"},
            {"start_ts": 7.0,  "end_ts": 9.0,  "label": "car"},
        ]
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 30)
        assert buckets[0]["counts"] == {"person": 2, "car": 1}
        assert buckets[0]["total"] == 3

    def test_db_row_tuple_input(self, idx):
        """Accepts DB row tuples (start_ts, end_ts, label, ...) as well as dicts."""
        # DB rows: (start_ts, end_ts, label, score, zones)
        events = [(5.0, 8.0, "person", 0.9, "[]")]
        buckets = idx.compute_density_buckets(events, 0.0, 30.0, 30)
        assert buckets[0]["counts"] == {"person": 1}
        assert buckets[0]["total"] == 1

    def test_bucket_count_matches_range(self, idx):
        """Number of buckets = ceil((end - start) / bucket_sec)."""
        buckets = idx.compute_density_buckets([], 0.0, 100.0, 30)
        # ceil(100 / 30) = 4
        assert len(buckets) == 4

    def test_event_at_bucket_boundary_inclusive(self, idx):
        """Event starting exactly at bucket boundary goes into that bucket."""
        # event [30, 40) — should be in bucket [30, 60), not [0, 30)
        events = [{"start_ts": 30.0, "end_ts": 40.0, "label": "dog"}]
        buckets = idx.compute_density_buckets(events, 0.0, 60.0, 30)
        assert buckets[0]["total"] == 0
        assert buckets[1]["total"] == 1
