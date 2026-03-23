"""Segment Indexer — scans Frigate's recording directory and builds the segment index.

Frigate recording path structure:
  {recordings_root}/{YYYY-MM-DD}/{HH}/{camera}/{MM}.{SS}.mp4

Each MP4 is a short segment (typically 10 seconds). The indexer:
  1. Walks the directory tree
  2. Parses timestamps from the path
  3. Optionally probes duration with ffprobe (batched) — probe=True only
  4. Inserts new segments into SQLite

Designed to run both as a one-shot CLI and as a periodic background task.
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.services.coverage import mark_covered

log = logging.getLogger(__name__)

# Assumed segment duration when probe=False (Frigate default segment length).
# Using this avoids the per-file ffprobe subprocess during bulk indexing, which
# would be prohibitively slow at 1M+ segments.  The actual duration matters only
# for exact gap calculations; for timeline rendering the approximation is fine.
ASSUMED_DURATION_SEC = 10.0

# Regex to parse: {YYYY-MM-DD}/{HH}/{camera}/{MM}.{SS}.mp4
SEGMENT_PATTERN = re.compile(
    r"^(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})/"
    r"(?P<hour>\d{2})/(?P<camera>[^/]+)/"
    r"(?P<minute>\d{2})\.(?P<second>\d{2})\.mp4$"
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


def _get_scan_state(conn: sqlite3.Connection) -> dict[str, float]:
    """Load last_scanned_ts per camera from scan_state table."""
    rows = conn.execute("SELECT camera, last_scanned_ts FROM scan_state").fetchall()
    return {r[0]: r[1] for r in rows}


def _write_scan_state(conn: sqlite3.Connection, camera: str, last_ts: float, last_path: str) -> None:
    """Upsert scan state for a camera after indexing."""
    conn.execute(
        """INSERT INTO scan_state (camera, last_scanned_ts, last_file_path)
           VALUES (?, ?, ?)
           ON CONFLICT(camera) DO UPDATE SET
             last_scanned_ts = excluded.last_scanned_ts,
             last_file_path  = excluded.last_file_path""",
        (camera, last_ts, last_path),
    )


def scan_recordings_dir(recordings_path: Path, scan_state: dict | None = None) -> list[dict]:
    """Walk the recordings directory and find segment files.

    Args:
        recordings_path: Root directory of Frigate recordings.
        scan_state: Per-camera dict {camera_name: last_scanned_ts} from
                    _get_scan_state(). If None, performs a full rglob.
                    Each camera uses its own cutoff so a slow camera
                    doesn't force faster cameras to re-scan old directories.

    Returns list of dicts with: camera, start_ts, path (relative), file_size.
    """
    segments = []
    root = recordings_path

    if not root.is_dir():
        log.error("Recordings path does not exist: %s", root)
        return segments

    if scan_state is None:
        # Full scan — used on first run when scan_state is empty
        mp4_files = list(root.rglob("*.mp4"))
    else:
        # Incremental scan — per-camera cutoffs at the camera directory level.
        # Day/hour directories are filtered with the global minimum cutoff;
        # individual camera directories are filtered with their own cutoff.
        global_since = min(scan_state.values()) if scan_state else 0
        mp4_files = []
        try:
            for day_entry in os.scandir(root):
                if not day_entry.is_dir():
                    continue
                if global_since > 0 and day_entry.stat().st_mtime < global_since - 600:
                    # Day directory untouched for all cameras — skip
                    continue
                for hour_entry in os.scandir(day_entry.path):
                    if not hour_entry.is_dir():
                        continue
                    if global_since > 0 and hour_entry.stat().st_mtime < global_since - 60:
                        continue
                    for cam_entry in os.scandir(hour_entry.path):
                        if not cam_entry.is_dir():
                            continue
                        cam_since = scan_state.get(cam_entry.name, 0)
                        if cam_since > 0 and cam_entry.stat().st_mtime < cam_since - 60:
                            # This camera's dir hasn't changed since our last scan
                            continue
                        for entry in os.scandir(cam_entry.path):
                            if entry.name.endswith(".mp4") and entry.is_file():
                                mp4_files.append(Path(entry.path))
        except PermissionError as exc:
            log.warning("Scan permission error: %s", exc)

    for mp4 in mp4_files:
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

    segments.sort(key=lambda s: (s["camera"], s["start_ts"]))
    return segments


def index_segments_sync(
    recordings_path: Path | None = None,
    db_path: Path | None = None,
    probe: bool = False,
    batch_size: int = 200,
) -> dict[str, int]:
    """Synchronous full index run. Returns {camera: new_segment_count}.

    Steps:
      1. Scan filesystem for all segment paths
      2. Filter out already-indexed paths
      3. Probe durations for new segments (if probe=True)
      4. Batch insert into SQLite

    probe defaults to False because calling ffprobe on every new segment would
    be prohibitively slow at scale (1M+ segments, 9 cameras).  Frigate segments
    are almost always exactly ASSUMED_DURATION_SEC (10 s), so the approximation
    is safe for timeline rendering and gap detection.  Pass probe=True only from
    the CLI when you need exact durations for a small set of files.
    """
    from app.models.database import init_db_sync

    recordings_path = recordings_path or settings.frigate_recordings_path
    db_path = db_path or settings.database_path

    init_db_sync()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    # Load incremental scan state — each camera gets its own cutoff timestamp
    scan_state = _get_scan_state(conn)

    # Get already-indexed paths
    existing = set(
        row[0] for row in conn.execute("SELECT path FROM segments").fetchall()
    )

    # Scan filesystem (incremental if we have prior state, full on first run)
    all_segments = scan_recordings_dir(recordings_path, scan_state=scan_state if scan_state else None)
    new_segments = [s for s in all_segments if s["path"] not in existing]

    if not new_segments:
        log.debug("No new segments found")
        # Still update scan_state so next scan uses current timestamp
        now_ts = time.time()
        conn.execute(
            """INSERT INTO scan_state (camera, last_scanned_ts, last_file_path)
               VALUES ('__global__', ?, NULL)
               ON CONFLICT(camera) DO UPDATE SET last_scanned_ts = excluded.last_scanned_ts""",
            (now_ts,),
        )
        conn.commit()
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
            duration = durations.get(seg["abs_path"], ASSUMED_DURATION_SEC)
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
        for seg in batch:
            mark_covered(seg["camera"], seg["start_ts"])
        log.info("Indexed batch %d-%d / %d", i, i + len(batch), len(new_segments))

    # Update scan_state per camera with the latest file timestamp we saw
    now_ts = time.time()
    for camera in camera_counts:
        camera_segs = [s for s in new_segments if s["camera"] == camera]
        if camera_segs:
            latest = max(s["start_ts"] for s in camera_segs)
            latest_path = max(camera_segs, key=lambda s: s["start_ts"])["path"]
            _write_scan_state(conn, camera, latest, latest_path)
    # Also update the global marker
    conn.execute(
        """INSERT INTO scan_state (camera, last_scanned_ts, last_file_path)
           VALUES ('__global__', ?, NULL)
           ON CONFLICT(camera) DO UPDATE SET last_scanned_ts = excluded.last_scanned_ts""",
        (now_ts,),
    )
    conn.commit()
    conn.close()
    log.info("Indexing complete: %s", camera_counts)
    return camera_counts


async def index_segments_async():
    """Async wrapper for indexing — runs in thread pool."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, index_segments_sync)


def index_segments_since(
    since_ts: float,
    recordings_path: Path | None = None,
    db_path: Path | None = None,
    progress_callback=None,  # callable(tag, done, total, extra) | None
) -> dict[str, int]:
    """Index all segments newer than since_ts, bypassing scan_state.

    Unlike index_segments_sync which uses mtime-based incremental scanning,
    this function walks the directory tree by DATE and only enters directories
    whose date/hour falls within [since_ts, now]. This guarantees it finds
    any segments that the incremental scanner missed.

    progress_callback(tag, done, total, extra) is called:
      - Once after discovery: tag="__discovered__", done=0, total=N, extra={camera: count}
      - After each batch commit: tag="__batch__", done=processed_so_far, total=N, extra={}

    Returns {camera: new_segment_count}.
    """
    from app.models.database import init_db_sync
    from datetime import timedelta

    recordings_path = recordings_path or settings.frigate_recordings_path
    db_path = db_path or settings.database_path
    init_db_sync()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    # Get already-indexed paths so we can skip them quickly
    existing = set(
        row[0] for row in conn.execute("SELECT path FROM segments").fetchall()
    )

    root = recordings_path
    if not root.is_dir():
        conn.close()
        return {}

    # Build set of (date_str, hour_str) pairs that fall within our window
    now = time.time()
    since_dt = datetime.fromtimestamp(since_ts, tz=timezone.utc)
    now_dt = datetime.fromtimestamp(now, tz=timezone.utc)

    valid_hours: set[tuple[str, str]] = set()
    cursor = since_dt.replace(minute=0, second=0, microsecond=0)
    while cursor <= now_dt + timedelta(hours=1):
        valid_hours.add((cursor.strftime("%Y-%m-%d"), cursor.strftime("%H")))
        cursor += timedelta(hours=1)

    valid_dates = {d for d, _h in valid_hours}

    # Walk only the matching directories
    mp4_files: list[Path] = []
    try:
        for day_entry in os.scandir(root):
            if not day_entry.is_dir():
                continue
            if day_entry.name not in valid_dates:
                continue
            for hour_entry in os.scandir(day_entry.path):
                if not hour_entry.is_dir():
                    continue
                if (day_entry.name, hour_entry.name) not in valid_hours:
                    continue
                for cam_entry in os.scandir(hour_entry.path):
                    if not cam_entry.is_dir():
                        continue
                    for entry in os.scandir(cam_entry.path):
                        if entry.name.endswith(".mp4") and entry.is_file():
                            mp4_files.append(Path(entry.path))
    except PermissionError as exc:
        log.warning("Reindex scan permission error: %s", exc)

    # Parse and filter to only new segments
    new_segments = []
    for mp4 in mp4_files:
        rel = mp4.relative_to(root)
        parsed = parse_segment_path(str(rel))
        if parsed is None:
            continue
        if str(rel) in existing:
            continue
        new_segments.append({
            **parsed,
            "path": str(rel),
            "abs_path": str(mp4),
            "file_size": mp4.stat().st_size,
        })

    if not new_segments:
        log.info("Targeted reindex: no new segments found in last %.0f hours",
                 (now - since_ts) / 3600)
        if progress_callback:
            progress_callback("__discovered__", 0, 0, {})
        conn.close()
        return {}

    log.info("Targeted reindex: found %d new segments in last %.0f hours",
             len(new_segments), (now - since_ts) / 3600)

    if progress_callback:
        by_camera: dict[str, int] = {}
        for seg in new_segments:
            by_camera[seg["camera"]] = by_camera.get(seg["camera"], 0) + 1
        progress_callback("__discovered__", 0, len(new_segments), by_camera)

    now_ts = time.time()
    camera_counts: dict[str, int] = {}
    batch_size = 200
    processed_so_far = 0

    for i in range(0, len(new_segments), batch_size):
        batch = new_segments[i:i + batch_size]
        rows = []
        for seg in batch:
            rows.append((
                seg["camera"],
                seg["start_ts"],
                seg["start_ts"] + ASSUMED_DURATION_SEC,
                ASSUMED_DURATION_SEC,
                seg["path"],
                seg["file_size"],
                now_ts,
                0,  # previews_generated = pending
            ))
            camera_counts[seg["camera"]] = camera_counts.get(seg["camera"], 0) + 1

        conn.executemany(
            """INSERT OR IGNORE INTO segments
               (camera, start_ts, end_ts, duration, path, file_size,
                indexed_at, previews_generated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
        for seg in batch:
            mark_covered(seg["camera"], seg["start_ts"])
        processed_so_far += len(batch)
        log.info("Reindex batch %d-%d / %d", i, i + len(batch), len(new_segments))
        if progress_callback:
            progress_callback("__batch__", processed_so_far, len(new_segments), {})

    conn.close()
    log.info("Targeted reindex complete: %s", camera_counts)
    return camera_counts


async def index_segments_since_async(since_ts: float, progress_callback=None) -> dict[str, int]:
    """Async wrapper for targeted reindex — runs in thread pool."""
    import functools
    loop = asyncio.get_running_loop()
    fn = functools.partial(index_segments_since, since_ts, progress_callback=progress_callback)
    return await loop.run_in_executor(None, fn)


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
