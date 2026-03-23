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
        """When segment is provided, sqlite3.connect is NOT called for segment lookup.

        On success, _clear_preview_failure_reason does call sqlite3.connect once
        (to clear any stale failure reason), but that is NOT a segment-lookup call.
        The invariant enforced here is: no segment lookup happens when segment is
        pre-provided. We verify this by inspecting that no SELECT FROM segments
        was executed.
        """
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

        # On success, connect is called exactly once — for _clear_preview_failure_reason,
        # NOT for a segment lookup. Verify no SELECT FROM segments was executed.
        executed_queries = [
            call_args[0][0]
            for call_args in mock_connect.return_value.execute.call_args_list
        ]
        assert not any("SELECT" in q for q in executed_queries), (
            "sqlite3.connect must not be used for segment lookup when segment is pre-provided; "
            f"found queries: {executed_queries}"
        )

    def test_stores_actual_dimensions_not_assumed_16x9(self, tmp_path, monkeypatch):
        """Actual file dimensions are used, not hardcoded 16:9."""
        from PIL import Image as PILImage

        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")
        ts = 1700000004.0

        def fake_run(cmd, **kwargs):
            out_path = Path(cmd[-1])
            out_path.parent.mkdir(parents=True, exist_ok=True)
            img = PILImage.new("RGB", (320, 240), color=(128, 128, 128))
            img.save(out_path, "JPEG")
            r = MagicMock()
            r.returncode = 0
            r.stderr = ""
            return r

        with patch("app.services.preview_generator.subprocess.run",
                   side_effect=fake_run):
            frame = pg.extract_preview_frame(
                camera="cam", ts=ts, width=320, quality=5, segment=segment,
            )

        assert frame is not None
        assert frame["width"] == 320
        assert frame["height"] == 240, (
            f"Expected height=240 (actual 4:3 output), got {frame['height']}. "
            "Do not assume 16:9 — read dimensions from the output file."
        )

    def test_falls_back_to_16x9_estimate_if_pil_fails(self, tmp_path, monkeypatch):
        """Returns a valid frame dict with the fallback height when PIL.Image.open raises."""
        recordings = tmp_path / "recordings"
        previews = tmp_path / "previews"
        recordings.mkdir()
        previews.mkdir()

        import app.services.preview_generator as pg
        _patch_settings(monkeypatch, recordings, previews, tmp_path / "db.sqlite3")
        monkeypatch.setattr(pg, "_VAAPI_DEVICE", None)

        segment = _make_segment(recordings, camera="cam")
        ts = 1700000004.0

        def fake_run(cmd, **kwargs):
            out_path = Path(cmd[-1])
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"fake jpeg")
            r = MagicMock()
            r.returncode = 0
            r.stderr = ""
            return r

        with patch("app.services.preview_generator.subprocess.run",
                   side_effect=fake_run):
            with patch("app.services.preview_generator.Image.open",
                       side_effect=OSError("corrupt header")):
                frame = pg.extract_preview_frame(
                    camera="cam", ts=ts, width=320, quality=5, segment=segment,
                )

        assert frame is not None, "Must return a valid frame dict even when PIL fails"
        assert frame["width"] == 320
        assert frame["height"] == int(320 * 9 / 16), (
            "Fallback height should be the 16:9 estimate when PIL.Image.open raises"
        )

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


class TestLazyVaapiProbe:

    def test_get_vaapi_device_returns_probe_result(self, monkeypatch):
        """_get_vaapi_device() calls _vaapi_device() and returns its result."""
        import app.services.preview_generator as pg

        monkeypatch.setattr(pg, "_VAAPI_DEVICE", "unchecked")
        monkeypatch.setattr(pg, "_vaapi_device", lambda: "/dev/dri/renderD128")

        result = pg._get_vaapi_device()
        assert result == "/dev/dri/renderD128"

    def test_get_vaapi_device_cached_after_first_call(self, monkeypatch):
        """_vaapi_device() is called exactly once; subsequent calls use the cached value."""
        import app.services.preview_generator as pg

        call_count = {"n": 0}

        def counting_probe():
            call_count["n"] += 1
            return "/dev/dri/renderD128"

        monkeypatch.setattr(pg, "_VAAPI_DEVICE", "unchecked")
        monkeypatch.setattr(pg, "_vaapi_device", counting_probe)

        pg._get_vaapi_device()
        pg._get_vaapi_device()
        pg._get_vaapi_device()

        assert call_count["n"] == 1, "_vaapi_device must be called exactly once"

    def test_vaapi_probe_not_called_at_import_time(self):
        """Reloading the module must not invoke _vaapi_device().

        Verified by patching shutil.which (the first call inside _vaapi_device)
        to raise — if any module-level code calls the probe, reload raises.
        """
        import importlib
        import shutil
        import app.services.preview_generator as pg

        original_which = shutil.which
        called = {"probe": False}

        def raising_which(name):
            if name == "ffmpeg":
                called["probe"] = True
                raise AssertionError("_vaapi_device was called at import/reload time")
            return original_which(name)

        shutil.which = raising_which
        try:
            importlib.reload(pg)
            assert not called["probe"], "_vaapi_device must not run at module import"
            assert pg._VAAPI_DEVICE == "unchecked", "sentinel must be set after reload"
        finally:
            shutil.which = original_which
            # Restore module to a clean post-reload state
            importlib.reload(pg)

    def test_get_vaapi_device_called_once_under_concurrency(self, monkeypatch):
        """Two threads calling _get_vaapi_device() simultaneously must trigger exactly one probe.

        The barrier belongs in the caller (not the probe) so both threads race
        to the first unchecked check simultaneously; only one wins the lock and
        calls _vaapi_device(); the second sees the updated value and short-circuits.
        """
        import time
        import app.services.preview_generator as pg

        call_count = {"n": 0}
        start_barrier = threading.Barrier(2)

        def slow_probe():
            call_count["n"] += 1
            time.sleep(0.05)  # hold lock briefly so second thread is definitely waiting
            return "/dev/dri/renderD128"

        monkeypatch.setattr(pg, "_VAAPI_DEVICE", "unchecked")
        monkeypatch.setattr(pg, "_vaapi_device", slow_probe)
        # Reset the lock so double-checked locking starts from a clean state
        monkeypatch.setattr(pg, "_VAAPI_LOCK", threading.Lock())

        results = []

        def caller():
            start_barrier.wait()  # both threads enter simultaneously
            results.append(pg._get_vaapi_device())

        t1 = threading.Thread(target=caller)
        t2 = threading.Thread(target=caller)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        assert call_count["n"] == 1, (
            f"_vaapi_device must be called exactly once under concurrency, got {call_count['n']}"
        )
        assert all(r == "/dev/dri/renderD128" for r in results), (
            "Both callers must receive the correct device path"
        )


# ---------------------------------------------------------------------------
# Recency pass tests (via worker helpers)
# ---------------------------------------------------------------------------

class TestRecencyPass:

    @pytest.mark.asyncio
    async def test_marks_segment_done_on_failure(self, tmp_path, monkeypatch):
        """After MAX_RETRIES failures previews_generated is set to 1.

        With the retry logic, a single failure increments retry_count and leaves
        previews_generated=0. Only on the MAX_RETRIES-th failure is the segment
        suppressed (previews_generated=1). This test drives the pass MAX_RETRIES
        times to reach suppression.
        """
        import app.services.worker as w
        from app import config

        db_path = tmp_path / "test.db"
        monkeypatch.setattr(config.settings, "database_path", db_path)
        monkeypatch.setattr(w.settings, "database_path", db_path)

        conn = sqlite3.connect(str(db_path))
        conn.execute("""CREATE TABLE segments
            (id INTEGER PRIMARY KEY, camera TEXT, start_ts REAL, end_ts REAL,
             duration REAL, path TEXT, file_size INTEGER, indexed_at REAL,
             previews_generated INTEGER DEFAULT 0,
             retry_count INTEGER NOT NULL DEFAULT 0)""")
        conn.execute("""CREATE TABLE previews
            (id INTEGER PRIMARY KEY, camera TEXT, ts REAL, segment_id INTEGER,
             image_path TEXT, width INTEGER, height INTEGER)""")
        import time
        recency_ts = time.time()
        conn.execute(
            "INSERT INTO segments VALUES (1,'cam',?,?,10.0,'cam/seg.mp4',1024,?,0,0)",
            (recency_ts, recency_ts + 10.0, recency_ts),
        )
        conn.commit()
        conn.close()

        monkeypatch.setattr(w, "extract_preview_frame", lambda **kwargs: None)
        monkeypatch.setattr(config.settings, "preview_recency_hours", 168)
        monkeypatch.setattr(w.settings, "preview_recency_hours", 168)

        # Drive MAX_RETRIES passes — segment stays in queue until final failure
        for _ in range(w.MAX_RETRIES):
            processed = await w._run_recency_pass(limit=10)
            assert processed == 1

        conn = sqlite3.connect(str(db_path))
        row = conn.execute(
            "SELECT previews_generated, retry_count FROM segments WHERE id = 1"
        ).fetchone()
        conn.close()
        assert row[0] == 1, "previews_generated must be 1 after MAX_RETRIES failures"
        assert row[1] == w.MAX_RETRIES, f"retry_count must be {w.MAX_RETRIES}"

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
             previews_generated INTEGER DEFAULT 0,
             retry_count INTEGER NOT NULL DEFAULT 0)""")
        conn.execute("""CREATE TABLE previews
            (id INTEGER PRIMARY KEY, camera TEXT, ts REAL, segment_id INTEGER,
             image_path TEXT, width INTEGER, height INTEGER)""")
        import time
        recency_ts = time.time()
        conn.execute(
            "INSERT INTO segments VALUES (1,'cam',?,?,10.0,'cam/seg.mp4',1024,?,0,0)",
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
