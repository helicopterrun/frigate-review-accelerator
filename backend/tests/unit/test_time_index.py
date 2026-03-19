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
