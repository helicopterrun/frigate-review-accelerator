"""In-memory segment coverage index.

Tracks which (camera, YYYY-MM-DD/HH) buckets have at least one segment.
Used by the preview hot path to avoid a DB query on every scrub miss.

Granularity: one hour. A bucket_ts in a covered hour means at least one
segment exists in that hour — generation is possible, so enqueue rather
than permanently 404.

Thread safety: CPython's GIL makes set.add / __contains__ safe for concurrent
reads and writes from asyncio + thread pool workers without a lock.
"""

from datetime import datetime, timezone

from app.config import settings

# (camera_name, "YYYY-MM-DD/HH") — mirrors Frigate's recording dir structure
_covered_buckets: set[tuple[str, str]] = set()


def _hour_key(camera: str, ts: float) -> tuple[str, str]:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return (camera, f"{dt:%Y-%m-%d}/{dt.hour:02d}")


def mark_covered(camera: str, segment_start_ts: float) -> None:
    """Record that camera has at least one segment in the hour containing segment_start_ts."""
    _covered_buckets.add(_hour_key(camera, segment_start_ts))


def is_covered(camera: str, bucket_ts: float) -> bool:
    """Return True if camera has at least one segment in the hour containing bucket_ts."""
    return _hour_key(camera, bucket_ts) in _covered_buckets


def populate_from_db(db_path=None) -> int:
    """Bulk-load coverage from the segments table at startup.

    One-time O(n) cost. Called once after init_db_sync() before the worker
    starts. Returns the number of segments loaded.
    """
    import sqlite3
    from pathlib import Path

    path = db_path or settings.database_path
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute("SELECT camera, start_ts FROM segments").fetchall()
    finally:
        conn.close()

    for camera, start_ts in rows:
        mark_covered(camera, start_ts)

    return len(rows)
