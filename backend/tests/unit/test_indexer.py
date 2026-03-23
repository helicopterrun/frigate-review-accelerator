"""Unit tests for the segment indexer."""

import os
import tempfile
import time

import pytest
from app.services.indexer import parse_segment_path, scan_recordings_dir
from pathlib import Path


class TestParseSegmentPath:
    def test_valid_path(self):
        result = parse_segment_path("2024-01-15/14/front-door/35.00.mp4")
        assert result is not None
        assert result["camera"] == "front-door"
        # 2024-01-15 14:35:00 UTC
        from datetime import datetime, timezone
        expected = datetime(2024, 1, 15, 14, 35, 0, tzinfo=timezone.utc).timestamp()
        assert result["start_ts"] == pytest.approx(expected, abs=1)

    def test_valid_path_midnight(self):
        result = parse_segment_path("2023-11-14/00/backyard/00.00.mp4")
        assert result is not None
        assert result["camera"] == "backyard"
        from datetime import datetime, timezone
        expected = datetime(2023, 11, 14, 0, 0, 0, tzinfo=timezone.utc).timestamp()
        assert result["start_ts"] == pytest.approx(expected, abs=1)

    def test_valid_path_camera_with_hyphens(self):
        result = parse_segment_path("2024-03-01/09/alley-east-cam/45.30.mp4")
        assert result is not None
        assert result["camera"] == "alley-east-cam"

    def test_invalid_format_missing_segment(self):
        assert parse_segment_path("2024-01-15/14/front-door/") is None

    def test_invalid_format_wrong_extension(self):
        assert parse_segment_path("2024-01-15/14/front-door/35.00.avi") is None

    def test_invalid_format_no_camera_dir(self):
        assert parse_segment_path("2024-01-15/14/35.00.mp4") is None

    def test_invalid_format_extra_levels(self):
        assert parse_segment_path("2024-01-15/14/front-door/sub/35.00.mp4") is None

    def test_invalid_date_month_out_of_range(self):
        # Month 13 is invalid — datetime raises ValueError, parse returns None
        result = parse_segment_path("2024-13-01/14/front-door/35.00.mp4")
        assert result is None

    def test_invalid_date_day_out_of_range(self):
        result = parse_segment_path("2024-02-30/14/front-door/35.00.mp4")
        assert result is None

    def test_invalid_date_hour_format(self):
        # Hour must be exactly 2 digits
        result = parse_segment_path("2024-01-15/1/front-door/35.00.mp4")
        assert result is None

    def test_empty_string(self):
        assert parse_segment_path("") is None

    def test_returns_dict_with_required_keys(self):
        result = parse_segment_path("2024-06-20/08/cam1/15.00.mp4")
        assert result is not None
        assert "camera" in result
        assert "start_ts" in result


class TestGlobalBucketTimestamps:
    """Bucket alignment invariants — now tested via TimeIndex.buckets_in_range."""

    def _buckets(self, start_ts, end_ts, interval=2.0):
        from app.services.time_index import TimeIndex
        return TimeIndex(interval=interval).buckets_in_range(start_ts, end_ts)

    def test_alignment_not_segment_relative(self):
        """Buckets must be globally aligned, NOT relative to segment start."""
        # Segment starting at non-round time
        buckets = self._buckets(1700000003.7, 1700000013.7)
        # All buckets must be divisible by 2.0
        for b in buckets:
            assert abs(b % 2.0) < 0.01, f"Bucket {b} is not globally aligned"

    def test_first_bucket_gte_start(self):
        buckets = self._buckets(1700000003.7, 1700000013.7)
        assert all(b >= 1700000003.7 for b in buckets)

    def test_last_bucket_lte_end(self):
        buckets = self._buckets(1700000003.7, 1700000013.7)
        assert all(b <= 1700000013.7 + 0.01 for b in buckets)

    def test_empty_range_returns_empty(self):
        # Range of 0.5s starting mid-interval — no bucket fits (next bucket is at 1700000012.0)
        buckets = self._buckets(1700000010.1, 1700000010.6)
        assert buckets == []

    def test_exact_boundary_included(self):
        """A bucket exactly at end_ts should be included."""
        buckets = self._buckets(1700000000.0, 1700000010.0)
        assert 1700000010.0 in buckets

    def test_interval_spacing(self):
        buckets = self._buckets(1700000000.0, 1700000020.0)
        for i in range(1, len(buckets)):
            gap = round(buckets[i] - buckets[i - 1], 3)
            assert gap == pytest.approx(2.0, abs=0.01)

    def test_count_correct(self):
        """interval=2, range=10 → 6 buckets at 0,2,4,6,8,10."""
        buckets = self._buckets(1700000000.0, 1700000010.0)
        assert len(buckets) == 6  # 0,2,4,6,8,10

    def test_non_integer_start(self):
        # start at 1.5, interval 2 → first bucket at 2.0
        buckets = self._buckets(1.5, 9.5)
        assert buckets[0] == pytest.approx(2.0, abs=0.01)


class TestPerCameraScanState:
    """scan_recordings_dir should use per-camera cutoffs, not a global minimum."""

    def _make_segment(self, root: Path, camera: str, filename: str = "00.00.mp4"):
        """Create a fake segment file in Frigate's directory structure."""
        seg_dir = root / "2024-01-15" / "14" / camera
        seg_dir.mkdir(parents=True, exist_ok=True)
        seg_file = seg_dir / filename
        seg_file.write_bytes(b"fake")
        return seg_dir, seg_file

    def test_per_camera_scan_state_independent(self):
        """
        cam-a has an older cutoff → its directory (with recent mtime) should be scanned.
        cam-b has a newer cutoff → its directory (with older mtime) should be skipped.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            # cam-a: cutoff 1700000000, directory mtime 1700000500 (after cutoff)
            cam_a_dir, _ = self._make_segment(root, "cam-a")
            os.utime(cam_a_dir, (1700000500, 1700000500))
            os.utime(cam_a_dir.parent, (1700000500, 1700000500))  # hour dir
            os.utime(cam_a_dir.parent.parent, (1700000500, 1700000500))  # day dir

            # cam-b: cutoff 1700001000, directory mtime 1700000900 (before cutoff - 60)
            cam_b_dir, _ = self._make_segment(root, "cam-b")
            os.utime(cam_b_dir, (1700000900, 1700000900))
            os.utime(cam_b_dir.parent, (1700000500, 1700000500))  # hour dir
            os.utime(cam_b_dir.parent.parent, (1700000500, 1700000500))  # day dir

            scan_state = {
                "cam-a": 1700000000.0,  # older cutoff
                "cam-b": 1700001000.0,  # newer cutoff — cam-b dir mtime is before this-60
            }
            segments = scan_recordings_dir(root, scan_state=scan_state)
            cameras_found = {s["camera"] for s in segments}

            assert "cam-a" in cameras_found, "cam-a should be scanned (dir mtime > cutoff)"
            assert "cam-b" not in cameras_found, "cam-b should be skipped (dir mtime < cutoff - 60)"

    def test_none_scan_state_does_full_scan(self):
        """scan_state=None → mtime walk with global_since=0, all cameras returned."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_segment(root, "cam-x")
            self._make_segment(root, "cam-y")

            segments = scan_recordings_dir(root, scan_state=None)
            cameras_found = {s["camera"] for s in segments}
            assert "cam-x" in cameras_found
            assert "cam-y" in cameras_found

    def test_none_scan_state_does_not_call_rglob(self, monkeypatch):
        """scan_state=None must NOT trigger Path.rglob (O(n_files) on cold start)."""
        def _rglob_should_not_be_called(self_path, *args, **kwargs):
            raise AssertionError("rglob was called — cold-start must use mtime walk, not rglob")

        monkeypatch.setattr(Path, "rglob", _rglob_should_not_be_called)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_segment(root, "cam-a")
            self._make_segment(root, "cam-b")
            self._make_segment(root, "cam-b", filename="05.00.mp4")

            # Must not raise even though rglob is patched to raise
            segments = scan_recordings_dir(root, scan_state=None)
            cameras_found = {s["camera"] for s in segments}
            assert "cam-a" in cameras_found
            assert "cam-b" in cameras_found
            assert len(segments) == 3

    def test_empty_scan_state_indexes_all_cameras(self, monkeypatch):
        """scan_state={} (explicit empty) behaves identically to scan_state=None."""
        def _rglob_should_not_be_called(self_path, *args, **kwargs):
            raise AssertionError("rglob was called — cold-start must use mtime walk, not rglob")

        monkeypatch.setattr(Path, "rglob", _rglob_should_not_be_called)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._make_segment(root, "cam-1")
            self._make_segment(root, "cam-2")
            self._make_segment(root, "cam-2", filename="10.00.mp4")

            segments = scan_recordings_dir(root, scan_state={})
            cameras_found = {s["camera"] for s in segments}
            assert "cam-1" in cameras_found
            assert "cam-2" in cameras_found
            assert len(segments) == 3
