"""Unit tests for index_segments_since — targeted reindex path."""

import os
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.indexer import index_segments_since


def _make_db(db_path: Path) -> None:
    """Create a minimal segments table so index_segments_since can run."""
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera TEXT, start_ts REAL, end_ts REAL, duration REAL,
            path TEXT UNIQUE, file_size INTEGER, indexed_at REAL,
            previews_generated INTEGER DEFAULT 0
        );
    """)
    conn.commit()
    conn.close()


class TestIndexSegmentsSinceScanning:
    """__scanning__ progress callback fires before any os.scandir call."""

    def test_scanning_callback_fires_before_scandir(self, tmp_path):
        """progress_callback('__scanning__', ...) must be emitted before the
        first os.scandir call, so the frontend can show a spinner during the
        directory walk phase."""
        call_order = []

        original_scandir = os.scandir

        def recording_scandir(path):
            call_order.append(("scandir", str(path)))
            return original_scandir(path)

        def progress_callback(tag, done, total, extra):
            call_order.append(("callback", tag))

        # Build a minimal recordings tree for the current hour so
        # index_segments_since has a valid directory to walk.
        now = time.time()
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(now, tz=timezone.utc)
        seg_dir = tmp_path / dt.strftime("%Y-%m-%d") / dt.strftime("%H") / "cam-a"
        seg_dir.mkdir(parents=True)
        (seg_dir / "00.00.mp4").write_bytes(b"fake")

        db_path = tmp_path / "test.db"
        _make_db(db_path)

        with patch("app.services.indexer.os.scandir", side_effect=recording_scandir), \
             patch("app.models.database.init_db_sync"):
            index_segments_since(
                since_ts=now - 3600,
                recordings_path=tmp_path,
                db_path=db_path,
                progress_callback=progress_callback,
            )

        # __scanning__ callback must appear before any scandir call
        scanning_pos = next(
            (i for i, e in enumerate(call_order) if e == ("callback", "__scanning__")),
            None,
        )
        assert scanning_pos is not None, "__scanning__ callback was never fired"

        first_scandir_pos = next(
            (i for i, e in enumerate(call_order) if e[0] == "scandir"),
            None,
        )
        assert first_scandir_pos is not None, "os.scandir was never called"
        assert scanning_pos < first_scandir_pos, (
            f"__scanning__ fired at position {scanning_pos} but "
            f"first os.scandir was at position {first_scandir_pos} — "
            "scanning callback must precede directory I/O"
        )

    def test_scanning_callback_not_fired_without_progress_callback(self, tmp_path):
        """When progress_callback=None, no AttributeError should occur."""
        db_path = tmp_path / "test.db"
        _make_db(db_path)

        with patch("app.models.database.init_db_sync"):
            result = index_segments_since(
                since_ts=time.time() - 3600,
                recordings_path=tmp_path,
                db_path=db_path,
                progress_callback=None,
            )
        # Empty tree → empty result, no crash
        assert result == {}
