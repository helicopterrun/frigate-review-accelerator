"""Unit tests for the single-frame preview extraction model (v3)."""

import sqlite3
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_segment(recordings_root: Path, camera: str = "cam", start_ts: float = 1700000000.0):
    """Create a dummy segment file and return a segment dict."""
    seg_dir = recordings_root / camera / "2023-11-14"
    seg_dir.mkdir(parents=True, exist_ok=True)
    seg_file = seg_dir / f"{start_ts:.0f}.mp4"
    seg_file.write_bytes(b"fake mp4")
    segment = {
        "id": 1,
        "camera": camera,
        "start_ts": start_ts,
        "end_ts": start_ts + 10.0,
        "duration": 10.0,
        "path": f"{camera}/2023-11-14/{start_ts:.0f}.mp4",
    }
    return segment


def _patch_settings(monkeypatch, recordings: Path, previews: Path, db_path: Path):
    """Patch preview_generator settings to use temp paths."""
    import app.services.preview_generator as pg
    monkeypatch.setattr(pg.settings, "frigate_recordings_path", recordings)
    monkeypatch.setattr(pg.settings, "preview_output_path", previews)
    monkeypatch.setattr(pg.settings, "database_path", db_path)


# ---------------------------------------------------------------------------
# extract_preview_frame tests
# ---------------------------------------------------------------------------

class TestExtractPreviewFrame:

    def test_single_subprocess_on_success(self, tmp_path, monkeypatch):
        """subprocess.run is called exactly once and the result is returned."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")
        ts = 1700000004.0

        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stderr = ""

        def fake_run(cmd, **kwargs):
            # Create the output file to simulate ffmpeg success
            out_path = Path(cmd[-1])
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"fake jpeg")
            return mock_run

        with patch("app.services.preview_generator.subprocess.run", side_effect=fake_run) as mock_subprocess:
            frame = pg.extract_preview_frame(
                camera="cam", ts=ts, width=320, quality=5, segment=segment,
            )

        assert mock_subprocess.call_count == 1
        assert frame is not None
        assert frame["ts"] == pytest.approx(ts)
        assert frame["camera"] == "cam"
        assert frame["segment_id"] == 1

    def test_no_retry_on_timeout(self, tmp_path, monkeypatch):
        """Returns None immediately on TimeoutExpired — no retry."""
        import subprocess
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")

        with patch(
            "app.services.preview_generator.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=[], timeout=60),
        ) as mock_subprocess:
            frame = pg.extract_preview_frame(
                camera="cam", ts=1700000004.0, width=320, quality=5, segment=segment,
            )

        assert frame is None
        assert mock_subprocess.call_count == 1

    def test_no_retry_on_nonzero_returncode(self, tmp_path, monkeypatch):
        """Returns None on rc=1 — no retry, no fallback."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "ffmpeg error"

        with patch(
            "app.services.preview_generator.subprocess.run", return_value=mock_result
        ) as mock_subprocess:
            frame = pg.extract_preview_frame(
                camera="cam", ts=1700000004.0, width=320, quality=5, segment=segment,
            )

        assert frame is None
        assert mock_subprocess.call_count == 1

    def test_skips_ffmpeg_if_file_exists(self, tmp_path, monkeypatch):
        """If the output file already exists, ffmpeg is never called."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")
        ts = 1700000004.0

        # Pre-create the output file
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        day_dir = previews / "cam" / dt.strftime("%Y-%m-%d")
        day_dir.mkdir(parents=True)
        output_path = day_dir / f"{ts:.2f}.jpg"
        output_path.write_bytes(b"cached jpeg")

        with patch("app.services.preview_generator.subprocess.run") as mock_subprocess:
            frame = pg.extract_preview_frame(
                camera="cam", ts=ts, width=320, quality=5, segment=segment,
            )

        assert mock_subprocess.call_count == 0
        assert frame is not None
        assert frame["ts"] == pytest.approx(ts)

    def test_uses_provided_segment(self, tmp_path, monkeypatch):
        """When segment is provided, sqlite3.connect is never called."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")

        def fake_run(cmd, **kwargs):
            out_path = Path(cmd[-1])
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"jpeg")
            r = MagicMock()
            r.returncode = 0
            r.stderr = ""
            return r

        with patch("app.services.preview_generator.subprocess.run", side_effect=fake_run):
            with patch("app.services.preview_generator.sqlite3.connect") as mock_connect:
                pg.extract_preview_frame(
                    camera="cam", ts=1700000004.0, width=320, quality=5, segment=segment,
                )

        mock_connect.assert_not_called()

    def test_returns_none_if_segment_not_found(self, tmp_path, monkeypatch):
        """Returns None without calling subprocess.run if DB has no matching segment."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.return_value = None

        with patch("app.services.preview_generator.subprocess.run") as mock_subprocess:
            with patch("app.services.preview_generator.sqlite3.connect", return_value=mock_conn):
                frame = pg.extract_preview_frame(
                    camera="cam", ts=1700000004.0, width=320, quality=5,
                )

        assert frame is None
        mock_subprocess.assert_not_called()


# ---------------------------------------------------------------------------
# enqueue_preview_request tests
# ---------------------------------------------------------------------------

class TestEnqueuePreviewRequest:

    def test_expands_window_into_individual_buckets(self, monkeypatch):
        """enqueue_preview_request expands a window into (camera, bucket_ts) pairs."""
        from app import config
        monkeypatch.setattr(config.settings, "preview_interval_sec", 2)

        import app.services.worker as w
        from collections import deque

        original_queue = w._demand_queue
        w._demand_queue = deque(maxlen=50)

        try:
            start = 1700000000.0
            end = 1700000006.0
            w.enqueue_preview_request("cam", start, end)

            entries = list(w._demand_queue)
            assert len(entries) >= 3
            for camera, bucket_ts in entries:
                assert camera == "cam"
                assert start <= bucket_ts <= end
        finally:
            w._demand_queue = original_queue


# ---------------------------------------------------------------------------
# VAAPI semaphore tests
# ---------------------------------------------------------------------------

class TestVaapiSemaphore:

    def test_vaapi_semaphore_is_threading_semaphore(self):
        """_vaapi_semaphore must be a threading.Semaphore instance."""
        import app.services.preview_generator as pg
        # threading.Semaphore() returns a _Semaphore, check via acquire/release
        assert hasattr(pg._vaapi_semaphore, "acquire")
        assert hasattr(pg._vaapi_semaphore, "release")

    def test_vaapi_max_concurrent_is_one(self):
        """_VAAPI_MAX_CONCURRENT must equal 1."""
        import app.services.preview_generator as pg
        assert pg._VAAPI_MAX_CONCURRENT == 1


# ---------------------------------------------------------------------------
# Recency pass tests (via worker helpers)
# ---------------------------------------------------------------------------

class TestRecencyPass:

    @pytest.mark.asyncio
    async def test_marks_segment_done_on_failure(self, tmp_path, monkeypatch):
        """previews_generated is set to 1 even when extract_preview_frame returns None."""
        import app.services.worker as w
        from app import config

        db_path = tmp_path / "test.db"
        monkeypatch.setattr(config.settings, "database_path", db_path)
        monkeypatch.setattr(w.settings, "database_path", db_path)

        conn = sqlite3.connect(str(db_path))
        conn.execute("""CREATE TABLE segments
            (id INTEGER PRIMARY KEY, camera TEXT, start_ts REAL, end_ts REAL,
             duration REAL, path TEXT, file_size INTEGER, indexed_at REAL,
             previews_generated INTEGER DEFAULT 0)""")
        conn.execute("""CREATE TABLE previews
            (id INTEGER PRIMARY KEY, camera TEXT, ts REAL, segment_id INTEGER,
             image_path TEXT, width INTEGER, height INTEGER)""")
        import time
        recency_ts = time.time()
        conn.execute(
            "INSERT INTO segments VALUES (1,'cam',?,?,10.0,'cam/seg.mp4',1024,?,0)",
            (recency_ts, recency_ts + 10.0, recency_ts),
        )
        conn.commit()
        conn.close()

        monkeypatch.setattr(w, "extract_preview_frame", lambda **kwargs: None)
        monkeypatch.setattr(config.settings, "preview_recency_hours", 168)
        monkeypatch.setattr(w.settings, "preview_recency_hours", 168)

        processed = await w._run_recency_pass(limit=10)
        assert processed == 1

        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT previews_generated FROM segments WHERE id = 1").fetchone()
        conn.close()
        assert row[0] == 1

        conn = sqlite3.connect(str(db_path))
        count = conn.execute("SELECT COUNT(*) FROM previews").fetchone()[0]
        conn.close()
        assert count == 0

    @pytest.mark.asyncio
    async def test_inserts_preview_on_success(self, tmp_path, monkeypatch):
        """previews row inserted and previews_generated set to 1 on success."""
        import app.services.worker as w
        from app import config

        db_path = tmp_path / "test.db"
        monkeypatch.setattr(config.settings, "database_path", db_path)
        monkeypatch.setattr(w.settings, "database_path", db_path)

        conn = sqlite3.connect(str(db_path))
        conn.execute("""CREATE TABLE segments
            (id INTEGER PRIMARY KEY, camera TEXT, start_ts REAL, end_ts REAL,
             duration REAL, path TEXT, file_size INTEGER, indexed_at REAL,
             previews_generated INTEGER DEFAULT 0)""")
        conn.execute("""CREATE TABLE previews
            (id INTEGER PRIMARY KEY, camera TEXT, ts REAL, segment_id INTEGER,
             image_path TEXT, width INTEGER, height INTEGER)""")
        import time
        recency_ts = time.time()
        conn.execute(
            "INSERT INTO segments VALUES (1,'cam',?,?,10.0,'cam/seg.mp4',1024,?,0)",
            (recency_ts, recency_ts + 10.0, recency_ts),
        )
        conn.commit()
        conn.close()

        def fake_extract(**kwargs):
            return {
                "ts": kwargs["ts"],
                "camera": kwargs["camera"],
                "segment_id": 1,
                "image_path": f"cam/2023-11-14/{kwargs['ts']:.2f}.jpg",
                "width": 320,
                "height": 180,
            }

        monkeypatch.setattr(w, "extract_preview_frame", fake_extract)
        monkeypatch.setattr(config.settings, "preview_recency_hours", 168)
        monkeypatch.setattr(w.settings, "preview_recency_hours", 168)

        processed = await w._run_recency_pass(limit=10)
        assert processed == 1

        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT previews_generated FROM segments WHERE id = 1").fetchone()
        assert row[0] == 1
        count = conn.execute("SELECT COUNT(*) FROM previews").fetchone()[0]
        conn.close()
        assert count == 1
