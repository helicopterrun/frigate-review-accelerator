"""Preview Frame Generator — extracts JPEG thumbnails from recording segments.

CRITICAL DESIGN DECISION: Global timestamp alignment.

Preview timestamps must align to a global grid, NOT to segment boundaries.
The bucket lookup in preview.py does:

    bucket_ts = round(ts / interval) * interval

So if interval=2, buckets are at 0, 2, 4, 6, 8... (relative to epoch).
A segment starting at 1700000003.7 must produce frames at:
    1700000004.0, 1700000006.0, 1700000008.0, ...
NOT at:
    1700000003.7, 1700000005.7, 1700000007.7, ...

If these drift, every scrub request will miss the bucket and fall through
to the DB fallback path — defeating the entire O(1) lookup design.

Implementation: we compute which global bucket timestamps fall within each
segment's time range, then use ffmpeg -ss to seek to the exact offset
within the segment for each frame. This is slightly more ffmpeg calls than
the fps filter approach, but guarantees alignment.

Output structure:
  {preview_output_path}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
"""

import asyncio
import logging
import math
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)


def _global_bucket_timestamps(start_ts: float, end_ts: float, interval: float) -> list[float]:
    """Compute globally-aligned bucket timestamps that fall within [start_ts, end_ts].

    Example with interval=2:
      start_ts=1700000003.7, end_ts=1700000013.7
      → [1700000004.0, 1700000006.0, 1700000008.0, 1700000010.0, 1700000012.0]

    The first bucket is the next interval boundary >= start_ts.
    The last bucket is the last interval boundary <= end_ts.
    """
    first = math.ceil(start_ts / interval) * interval
    buckets = []
    t = first
    while t <= end_ts:
        buckets.append(round(t, 2))  # avoid float drift
        t += interval
    return buckets


def _extract_frame_at_offset(
    video_path: Path,
    offset_sec: float,
    output_path: Path,
    width: int,
    quality: int,
) -> bool:
    """Extract a single JPEG frame at a specific offset within a video file.

    Uses -ss before -i for fast keyframe-based seeking.
    Returns True on success.
    """
    cmd = [
        "ffmpeg",
        "-v", "quiet",
        "-ss", f"{offset_sec:.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-vf", f"scale={width}:-1",
        "-q:v", str(quality),
        "-y",  # overwrite if exists
        str(output_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return result.returncode == 0 and output_path.exists()
    except subprocess.TimeoutExpired:
        return False


def generate_previews_for_segment(
    segment_path: str,
    camera: str,
    start_ts: float,
    end_ts: float,
    duration: float,
    segment_id: int,
    recordings_root: Path | None = None,
    output_root: Path | None = None,
) -> list[dict]:
    """Extract globally-aligned preview frames from a single segment.

    Returns list of dicts: {ts, image_path, width, height, segment_id, camera}
    """
    recordings_root = recordings_root or settings.frigate_recordings_path
    output_root = output_root or settings.preview_output_path

    abs_path = recordings_root / segment_path
    if not abs_path.exists():
        log.warning("Segment file missing: %s", abs_path)
        return []

    interval = settings.preview_interval_sec
    width = settings.preview_width
    quality = settings.preview_quality

    # Compute which global buckets fall within this segment
    buckets = _global_bucket_timestamps(start_ts, end_ts, interval)
    if not buckets:
        return []

    # Create output directory: {output_root}/{camera}/{YYYY-MM-DD}/
    dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
    day_dir = output_root / camera / dt.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)

    frames = []
    est_height = int(width * 9 / 16)

    for bucket_ts in buckets:
        # Offset within the segment file
        offset = bucket_ts - start_ts

        # Skip if offset is negative or past segment end (shouldn't happen
        # given _global_bucket_timestamps, but defensive)
        if offset < 0 or offset > duration + 0.5:
            continue

        # Output filename IS the bucket timestamp — this is what makes
        # O(1) lookup work in preview.py
        filename = f"{bucket_ts:.2f}.jpg"
        output_path = day_dir / filename

        # Skip if already generated (idempotent)
        if output_path.exists():
            rel_path = str(output_path.relative_to(output_root))
            frames.append({
                "ts": bucket_ts,
                "image_path": rel_path,
                "width": width,
                "height": est_height,
                "segment_id": segment_id,
                "camera": camera,
            })
            continue

        # Extract the frame
        success = _extract_frame_at_offset(
            abs_path, offset, output_path, width, quality
        )

        if success:
            rel_path = str(output_path.relative_to(output_root))
            frames.append({
                "ts": bucket_ts,
                "image_path": rel_path,
                "width": width,
                "height": est_height,
                "segment_id": segment_id,
                "camera": camera,
            })
        else:
            log.debug(
                "Failed to extract frame at offset %.2f from %s",
                offset, segment_path,
            )

    return frames


def process_pending_segments(
    db_path: Path | None = None,
    limit: int = 50,
) -> int:
    """Process segments that don't have previews yet.

    Returns number of segments processed.
    """
    db_path = db_path or settings.database_path

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """SELECT id, camera, start_ts, end_ts, duration, path
           FROM segments
           WHERE previews_generated = 0
           ORDER BY start_ts DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()

    if not rows:
        log.debug("No pending segments for preview generation")
        conn.close()
        return 0

    log.info("Generating previews for %d segments", len(rows))
    processed = 0

    for row in rows:
        frames = generate_previews_for_segment(
            segment_path=row["path"],
            camera=row["camera"],
            start_ts=row["start_ts"],
            end_ts=row["end_ts"],
            duration=row["duration"],
            segment_id=row["id"],
        )

        if frames:
            conn.executemany(
                """INSERT OR IGNORE INTO previews
                   (camera, ts, segment_id, image_path, width, height)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [(f["camera"], f["ts"], f["segment_id"],
                  f["image_path"], f["width"], f["height"]) for f in frames],
            )

        # Mark as processed (even if 0 frames — segment may be too short
        # to contain any global bucket timestamps)
        conn.execute(
            "UPDATE segments SET previews_generated = 1 WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
        processed += 1

        if processed % 10 == 0:
            log.info("Progress: %d / %d segments", processed, len(rows))

    conn.close()
    log.info(
        "Preview generation complete: %d segments, frames in %s",
        processed, settings.preview_output_path,
    )
    return processed


async def process_pending_async(limit: int = 50) -> int:
    """Async wrapper for preview generation."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, process_pending_segments, None, limit)


# CLI entry point
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    log.info("Starting preview generator...")
    log.info("Interval: %ds, Width: %dpx", settings.preview_interval_sec, settings.preview_width)
    count = process_pending_segments(limit=500)
    log.info("Done. Processed %d segments.", count)
