"""Segment Indexer — scans Frigate's recording directory and builds the segment index.

Frigate recording path structure:
  {recordings_root}/{camera}/{YYYY-MM}/{DD}/{HH}/{MM}.{SS}.mp4

Each MP4 is a short segment (typically 10 seconds). The indexer:
  1. Walks the directory tree
  2. Parses timestamps from the path
  3. Probes duration with ffprobe (batched)
  4. Inserts new segments into SQLite

Designed to run both as a one-shot CLI and as a periodic background task.
"""

import asyncio
import json
import logging
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)

# Regex to parse: {camera}/{YYYY-MM}/{DD}/{HH}/{MM}.{SS}.mp4
SEGMENT_PATTERN = re.compile(
    r"^(?P<camera>[^/]+)/(?P<year>\d{4})-(?P<month>\d{2})/(?P<day>\d{2})/"
    r"(?P<hour>\d{2})/(?P<minute>\d{2})\.(?P<second>\d{2})\.mp4$"
)


def parse_segment_path(rel_path: str) -> dict | None:
    """Parse a relative path into camera name and start timestamp.

    Returns dict with camera, start_ts, or None if path doesn't match.
    """
    m = SEGMENT_PATTERN.match(rel_path)
    if not m:
        return None

    try:
        dt = datetime(
            year=int(m.group("year")),
            month=int(m.group("month")),
            day=int(m.group("day")),
            hour=int(m.group("hour")),
            minute=int(m.group("minute")),
            second=int(m.group("second")),
            tzinfo=timezone.utc,
        )
        return {
            "camera": m.group("camera"),
            "start_ts": dt.timestamp(),
        }
    except ValueError:
        return None


def probe_duration(file_path: Path) -> float | None:
    """Get video duration in seconds using ffprobe.

    Returns None if ffprobe fails (corrupt file, etc).
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except (subprocess.TimeoutExpired, KeyError, json.JSONDecodeError, ValueError):
        return None


def probe_durations_batch(file_paths: list[Path], max_workers: int = 4) -> dict[str, float]:
    """Probe durations for multiple files using concurrent subprocesses.

    Returns {path_str: duration} for files that succeeded.
    """
    from concurrent.futures import ThreadPoolExecutor

    results = {}

    def _probe(fp: Path):
        dur = probe_duration(fp)
        if dur is not None:
            results[str(fp)] = dur

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        pool.map(_probe, file_paths)

    return results


def scan_recordings_dir(recordings_path: Path) -> list[dict]:
    """Walk the recordings directory and find all segment files.

    Returns list of dicts with: camera, start_ts, path (relative), file_size.
    Only returns files not yet in the database.
    """
    segments = []
    root = recordings_path

    if not root.is_dir():
        log.error("Recordings path does not exist: %s", root)
        return segments

    for mp4 in root.rglob("*.mp4"):
        rel = mp4.relative_to(root)
        parsed = parse_segment_path(str(rel))
        if parsed is None:
            continue

        segments.append({
            **parsed,
            "path": str(rel),
            "abs_path": str(mp4),
            "file_size": mp4.stat().st_size,
        })

    # Sort by camera then timestamp for consistent processing
    segments.sort(key=lambda s: (s["camera"], s["start_ts"]))
    return segments


def index_segments_sync(
    recordings_path: Path | None = None,
    db_path: Path | None = None,
    probe: bool = True,
    batch_size: int = 200,
) -> dict[str, int]:
    """Synchronous full index run. Returns {camera: new_segment_count}.

    Steps:
      1. Scan filesystem for all segment paths
      2. Filter out already-indexed paths
      3. Probe durations for new segments (if probe=True)
      4. Batch insert into SQLite

    If probe=False, estimates duration as 10s (Frigate default segment length).
    This is much faster for initial bulk indexing.
    """
    from app.models.database import init_db_sync

    recordings_path = recordings_path or settings.frigate_recordings_path
    db_path = db_path or settings.database_path

    init_db_sync()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    # Get already-indexed paths
    existing = set(
        row[0] for row in conn.execute("SELECT path FROM segments").fetchall()
    )

    # Scan filesystem
    all_segments = scan_recordings_dir(recordings_path)
    new_segments = [s for s in all_segments if s["path"] not in existing]

    if not new_segments:
        log.info("No new segments found")
        conn.close()
        return {}

    log.info("Found %d new segments to index", len(new_segments))

    # Probe durations in batches
    now = time.time()
    camera_counts: dict[str, int] = {}

    for i in range(0, len(new_segments), batch_size):
        batch = new_segments[i : i + batch_size]

        if probe:
            abs_paths = [Path(s["abs_path"]) for s in batch]
            durations = probe_durations_batch(abs_paths, max_workers=settings.preview_workers)
        else:
            durations = {}

        rows = []
        for seg in batch:
            duration = durations.get(seg["abs_path"], 10.0)  # default 10s
            rows.append((
                seg["camera"],
                seg["start_ts"],
                seg["start_ts"] + duration,
                duration,
                seg["path"],
                seg["file_size"],
                now,
                0,  # previews_generated = pending
            ))
            camera_counts[seg["camera"]] = camera_counts.get(seg["camera"], 0) + 1

        conn.executemany(
            """INSERT OR IGNORE INTO segments
               (camera, start_ts, end_ts, duration, path, file_size, indexed_at, previews_generated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
        log.info("Indexed batch %d-%d / %d", i, i + len(batch), len(new_segments))

    conn.close()
    log.info("Indexing complete: %s", camera_counts)
    return camera_counts


async def index_segments_async():
    """Async wrapper for indexing — runs in thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, index_segments_sync)


# CLI entry point
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("Starting segment indexer...")
    log.info("Recordings path: %s", settings.frigate_recordings_path)
    log.info("Database path: %s", settings.database_path)

    result = index_segments_sync(probe=False)  # skip probe for speed on first run
    for camera, count in sorted(result.items()):
        log.info("  %s: %d new segments", camera, count)

    if not result:
        log.info("No new segments found. Is FRIGATE_RECORDINGS_PATH correct?")
