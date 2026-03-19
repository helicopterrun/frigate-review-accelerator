"""Unit tests for generate_previews_for_segment with target_bucket_ts."""

import pytest
from pathlib import Path
from unittest.mock import patch


@pytest.fixture()
def segment_env(tmp_path, monkeypatch):
    """Set up temp directories and a dummy segment file."""
    from app import config
    monkeypatch.setattr(config.settings, "preview_interval_sec", 2)
    monkeypatch.setattr(config.settings, "preview_width", 320)

    recordings = tmp_path / "recordings"
    previews = tmp_path / "previews"
    recordings.mkdir()
    previews.mkdir()

    # Create a dummy segment file at the expected relative path
    seg_dir = recordings / "cam" / "2023-11-14"
    seg_dir.mkdir(parents=True)
    seg_file = seg_dir / "1700000000.mp4"
    seg_file.write_bytes(b"fake mp4")

    return {
        "recordings": recordings,
        "previews": previews,
        "segment_path": "cam/2023-11-14/1700000000.mp4",
        "camera": "cam",
        "start_ts": 1700000000.0,
        "end_ts": 1700000010.0,
        "duration": 10.0,
        "segment_id": 1,
    }


def _make_mock_batch(captured: dict):
    """Return a mock _extract_frames_batch that records its buckets arg."""
    def mock_batch(video_path, buckets, start_ts, day_dir, width, quality):
        captured["buckets"] = list(buckets)
        return [
            {
                "ts": b,
                "image_path": f"cam/2023-11-14/{b:.2f}.jpg",
                "width": width,
                "height": int(width * 9 / 16),
            }
            for b in buckets
        ]
    return mock_batch


class TestTargetBucketTs:
    def test_target_bucket_ts_generates_exactly_one_frame(self, segment_env, monkeypatch):
        """With target_bucket_ts, _extract_frames_batch is called with exactly one bucket."""
        import app.services.preview_generator as pg

        captured = {}
        monkeypatch.setattr(pg, "_extract_frames_batch", _make_mock_batch(captured))

        env = segment_env
        result = pg.generate_previews_for_segment(
            segment_path=env["segment_path"],
            camera=env["camera"],
            start_ts=env["start_ts"],
            end_ts=env["end_ts"],
            duration=env["duration"],
            segment_id=env["segment_id"],
            recordings_root=env["recordings"],
            output_root=env["previews"],
            target_bucket_ts=1700000002.0,
        )

        assert len(captured.get("buckets", [])) == 1
        assert captured["buckets"][0] == pytest.approx(1700000002.0)
        assert len(result) == 1
        assert result[0]["ts"] == pytest.approx(1700000002.0)

    def test_target_bucket_ts_outside_segment_returns_empty(self, segment_env, monkeypatch):
        """target_bucket_ts outside [start_ts, end_ts+0.5] must return [] immediately."""
        import app.services.preview_generator as pg

        captured = {}
        monkeypatch.setattr(pg, "_extract_frames_batch", _make_mock_batch(captured))

        env = segment_env
        result = pg.generate_previews_for_segment(
            segment_path=env["segment_path"],
            camera=env["camera"],
            start_ts=env["start_ts"],
            end_ts=env["end_ts"],
            duration=env["duration"],
            segment_id=env["segment_id"],
            recordings_root=env["recordings"],
            output_root=env["previews"],
            target_bucket_ts=1700001000.0,  # way outside range
        )

        assert result == []
        assert "buckets" not in captured  # _extract_frames_batch never called

    def test_no_target_bucket_ts_generates_all_buckets(self, segment_env, monkeypatch):
        """Without target_bucket_ts, all buckets in the segment range are passed to batch."""
        import app.services.preview_generator as pg
        from app.services.preview_generator import _global_bucket_timestamps
        from app import config

        captured = {}
        monkeypatch.setattr(pg, "_extract_frames_batch", _make_mock_batch(captured))

        env = segment_env
        interval = config.settings.preview_interval_sec
        expected_buckets = _global_bucket_timestamps(
            env["start_ts"], env["end_ts"], interval
        )

        result = pg.generate_previews_for_segment(
            segment_path=env["segment_path"],
            camera=env["camera"],
            start_ts=env["start_ts"],
            end_ts=env["end_ts"],
            duration=env["duration"],
            segment_id=env["segment_id"],
            recordings_root=env["recordings"],
            output_root=env["previews"],
            target_bucket_ts=None,
        )

        assert len(captured.get("buckets", [])) == len(expected_buckets)
        assert len(captured["buckets"]) > 1
