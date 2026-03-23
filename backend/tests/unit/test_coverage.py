"""Tests for the in-memory segment coverage index (app.services.coverage)."""

import sqlite3
import tempfile
from pathlib import Path

import pytest

# Reset module state between tests so each test gets a clean slate
@pytest.fixture(autouse=True)
def reset_coverage():
    import app.services.coverage as cov
    cov._covered_buckets.clear()
    yield
    cov._covered_buckets.clear()


# --- mark_covered / is_covered round-trip ---

def test_mark_and_is_covered():
    from app.services.coverage import mark_covered, is_covered

    ts = 1700000004.0  # some arbitrary timestamp
    assert not is_covered("front_door", ts)
    mark_covered("front_door", ts)
    assert is_covered("front_door", ts)


def test_is_covered_wrong_camera():
    """is_covered must return False for a different camera with the same timestamp."""
    from app.services.coverage import mark_covered, is_covered

    ts = 1700000004.0
    mark_covered("front_door", ts)
    assert not is_covered("back_yard", ts)


def test_is_covered_different_hour():
    """is_covered must return False for a ts in a different hour from the covered one."""
    from app.services.coverage import mark_covered, is_covered

    # 2023-11-14 22:13:24 UTC  (hour 22)
    ts_hour22 = 1700000004.0
    mark_covered("garage", ts_hour22)

    # ~3600 s later → hour 23
    ts_hour23 = ts_hour22 + 3600.0
    assert not is_covered("garage", ts_hour23)


def test_is_covered_same_hour_different_minute():
    """Any ts in the same hour as a covered ts should be covered."""
    from app.services.coverage import mark_covered, is_covered

    ts_base = 1700000004.0  # lands in some hour
    mark_covered("driveway", ts_base)

    # +30 minutes — same hour
    ts_later = ts_base + 1800.0
    assert is_covered("driveway", ts_later)


# --- Bulk startup population ---

def test_populate_from_db():
    """populate_from_db must mark all camera/hour pairs from the segments table."""
    from app.services.coverage import populate_from_db, is_covered

    # Three segments: two on the same camera/hour, one on a different camera
    segments = [
        ("front_door", 1700000004.0),
        ("front_door", 1700000014.0),   # same hour as above
        ("back_yard",  1700007200.0),   # different camera, different hour
    ]

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            """CREATE TABLE segments (
                id INTEGER PRIMARY KEY,
                camera TEXT NOT NULL,
                start_ts REAL NOT NULL,
                end_ts REAL,
                duration REAL,
                path TEXT,
                file_size INTEGER,
                indexed_at REAL,
                previews_generated INTEGER DEFAULT 0,
                preview_failure_reason TEXT,
                retry_count INTEGER DEFAULT 0
            )"""
        )
        conn.executemany(
            "INSERT INTO segments (camera, start_ts) VALUES (?, ?)",
            segments,
        )
        conn.commit()
        conn.close()

        count = populate_from_db(db_path)

    assert count == 3
    assert is_covered("front_door", 1700000004.0)
    assert is_covered("front_door", 1700000014.0)
    assert is_covered("back_yard", 1700007200.0)
    # A camera not in the DB should not be covered
    assert not is_covered("side_gate", 1700000004.0)
