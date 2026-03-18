"""Unit tests for the segment indexer."""

import pytest
from app.services.indexer import parse_segment_path


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
    def test_alignment_not_segment_relative(self):
        """Buckets must be globally aligned, NOT relative to segment start."""
        from app.services.preview_generator import _global_bucket_timestamps
        # Segment starting at non-round time
        buckets = _global_bucket_timestamps(1700000003.7, 1700000013.7, 2.0)
        # All buckets must be divisible by 2.0
        for b in buckets:
            assert abs(b % 2.0) < 0.01, f"Bucket {b} is not globally aligned"

    def test_first_bucket_gte_start(self):
        from app.services.preview_generator import _global_bucket_timestamps
        buckets = _global_bucket_timestamps(1700000003.7, 1700000013.7, 2.0)
        assert all(b >= 1700000003.7 for b in buckets)

    def test_last_bucket_lte_end(self):
        from app.services.preview_generator import _global_bucket_timestamps
        buckets = _global_bucket_timestamps(1700000003.7, 1700000013.7, 2.0)
        assert all(b <= 1700000013.7 + 0.01 for b in buckets)

    def test_empty_range_returns_empty(self):
        from app.services.preview_generator import _global_bucket_timestamps
        # Range of 0.5s starting mid-interval — no bucket fits (next bucket is at 1700000012.0)
        buckets = _global_bucket_timestamps(1700000010.1, 1700000010.6, 2.0)
        assert buckets == []

    def test_exact_boundary_included(self):
        """A bucket exactly at end_ts should be included."""
        from app.services.preview_generator import _global_bucket_timestamps
        buckets = _global_bucket_timestamps(1700000000.0, 1700000010.0, 2.0)
        assert 1700000010.0 in buckets

    def test_interval_spacing(self):
        from app.services.preview_generator import _global_bucket_timestamps
        buckets = _global_bucket_timestamps(1700000000.0, 1700000020.0, 2.0)
        for i in range(1, len(buckets)):
            gap = round(buckets[i] - buckets[i - 1], 3)
            assert gap == pytest.approx(2.0, abs=0.01)

    def test_count_correct(self):
        """interval=2, range=10 → 5 buckets at 0,2,4,6,8 (or 2,4,6,8,10)."""
        from app.services.preview_generator import _global_bucket_timestamps
        buckets = _global_bucket_timestamps(1700000000.0, 1700000010.0, 2.0)
        assert len(buckets) == 6  # 0,2,4,6,8,10

    def test_non_integer_start(self):
        from app.services.preview_generator import _global_bucket_timestamps
        # start at 1.5, interval 2 → first bucket at 2.0
        buckets = _global_bucket_timestamps(1.5, 9.5, 2.0)
        assert buckets[0] == pytest.approx(2.0, abs=0.01)
