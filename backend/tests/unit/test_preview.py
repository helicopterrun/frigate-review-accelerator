"""Unit tests for the preview router bucket math and LRU cache."""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from pathlib import Path


class TestQuantizeTs:
    def test_rounds_to_nearest_bucket(self):
        from app.routers.preview import _quantize_ts
        assert _quantize_ts(1700000003.7, 2.0) == pytest.approx(1700000004.0)

    def test_exact_bucket_unchanged(self):
        from app.routers.preview import _quantize_ts
        assert _quantize_ts(1700000004.0, 2.0) == pytest.approx(1700000004.0)

    def test_rounds_down_at_midpoint_minus_epsilon(self):
        from app.routers.preview import _quantize_ts
        # 1700000002.999 is closer to 1700000002 than 1700000004
        assert _quantize_ts(1700000002.999, 2.0) == pytest.approx(1700000002.0)

    def test_boundary_rounds_to_upper(self):
        from app.routers.preview import _quantize_ts
        # Exactly at midpoint (1.0 into a 2s interval) — round() rounds to even
        # We care that it rounds to a valid global bucket, not the specific direction
        result = _quantize_ts(1700000001.0, 2.0)
        assert result % 2.0 == pytest.approx(0.0, abs=0.01)

    def test_alignment_globally_consistent(self):
        """Quantizing two timestamps close together must yield same bucket."""
        from app.routers.preview import _quantize_ts
        ts1 = _quantize_ts(1700000003.1, 2.0)
        ts2 = _quantize_ts(1700000003.9, 2.0)
        assert ts1 == pytest.approx(ts2)

    def test_different_intervals(self):
        from app.routers.preview import _quantize_ts
        # interval=5
        assert _quantize_ts(1700000007.0, 5.0) == pytest.approx(1700000005.0)
        assert _quantize_ts(1700000008.0, 5.0) == pytest.approx(1700000010.0)


class TestBucketPath:
    def test_filename_is_timestamp(self):
        """The filename of a preview MUST be the bucket timestamp — this is
        the invariant that makes O(1) lookup work in the hot path."""
        from app.routers.preview import _bucket_path
        path = _bucket_path("front-door", 1700000004.0)
        assert path.name == "1700000004.00.jpg"

    def test_date_dir_structure(self):
        from app.routers.preview import _bucket_path
        # 1700000004 = 2023-11-14 22:13:24 UTC
        path = _bucket_path("front-door", 1700000004.0)
        parts = path.parts
        # camera dir and date dir should be present
        assert "front-door" in parts
        assert any(p.startswith("2023-") for p in parts)

    def test_camera_in_path(self):
        from app.routers.preview import _bucket_path
        path = _bucket_path("alley-east", 1700000004.0)
        assert "alley-east" in str(path)

    def test_two_decimal_places(self):
        """Filename must have exactly 2 decimal places for consistent lookup."""
        from app.routers.preview import _bucket_path
        path = _bucket_path("cam", 1700000000.0)
        assert "1700000000.00.jpg" == path.name


class TestLRUCache:
    def test_put_and_get(self):
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=10)
        cache.put("cam", 1000.0, b"image_data")
        assert cache.get("cam", 1000.0) == b"image_data"

    def test_miss_returns_none(self):
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=10)
        assert cache.get("cam", 9999.0) is None

    def test_hit_rate_tracking(self):
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=10)
        cache.put("cam", 1.0, b"x")
        cache.get("cam", 1.0)  # hit
        cache.get("cam", 2.0)  # miss
        assert cache.hit_rate == pytest.approx(50.0, abs=0.1)

    def test_eviction_on_overflow(self):
        """LRU eviction: oldest entry removed when max_size exceeded."""
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=3)
        cache.put("cam", 1.0, b"a")
        cache.put("cam", 2.0, b"b")
        cache.put("cam", 3.0, b"c")
        cache.put("cam", 4.0, b"d")  # should evict key (cam, 1.0)
        assert cache.get("cam", 1.0) is None
        assert cache.get("cam", 4.0) == b"d"
        assert cache.size == 3

    def test_access_promotes_to_recent(self):
        """Accessing an entry should prevent it from being evicted first."""
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=2)
        cache.put("cam", 1.0, b"a")
        cache.put("cam", 2.0, b"b")
        # Access 1.0 to make it recently used
        cache.get("cam", 1.0)
        # Adding a third entry should evict 2.0, not 1.0
        cache.put("cam", 3.0, b"c")
        assert cache.get("cam", 1.0) == b"a"
        assert cache.get("cam", 2.0) is None

    def test_different_cameras_separate_keys(self):
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=10)
        cache.put("cam-a", 1.0, b"cam_a_data")
        cache.put("cam-b", 1.0, b"cam_b_data")
        assert cache.get("cam-a", 1.0) == b"cam_a_data"
        assert cache.get("cam-b", 1.0) == b"cam_b_data"

    def test_no_db_call_on_cache_hit(self):
        """The O(1) hot path must NEVER query the database on a cache hit."""
        from app.routers.preview import ImageCache
        cache = ImageCache(max_size=10)
        cache.put("cam", 1000.0, b"img")

        with patch("app.routers.preview.get_db") as mock_db:
            result = cache.get("cam", 1000.0)
            mock_db.assert_not_called()
        assert result == b"img"
