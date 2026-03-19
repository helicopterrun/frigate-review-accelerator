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

v2 batch extraction: single ffmpeg call per segment using the `select` filter
to extract all frames at once. Frames are written to a temp dir, then renamed
to their globally-aligned bucket timestamp and moved to the final location.
The per-frame fallback is retained for edge cases.

Output structure:
  {preview_output_path}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
"""

import asyncio
import logging
import math
import os
import shutil
import sqlite3
import subprocess
import subprocess as _sp
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)


def _vaapi_device() -> str | None:
    """Return /dev/dri/renderD128 if VAAPI is available, else None."""
    device = "/dev/dri/renderD128"
    if not shutil.which("ffmpeg"):
        return None
    try:
        if not os.path.exists(device):
            return None
        result = _sp.run(
            ["ffmpeg", "-v", "quiet", "-hwaccel", "vaapi",
             "-hwaccel_device", device, "-f", "lavfi", "-i", "nullsrc",
             "-frames:v", "1", "-f", "null", "-"],
            capture_output=True, timeout=5,
        )
        return device if result.returncode == 0 else None
    except Exception:
        return None


_VAAPI_DEVICE: str | None = _vaapi_device()

if _VAAPI_DEVICE:
    log.info("VAAPI hardware decode enabled (%s)", _VAAPI_DEVICE)
else:
    log.info("VAAPI not available, using software decode")


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


def _extract_frames_batch(
    video_path: Path,
    buckets: list[float],
    start_ts: float,
    day_dir: Path,
    width: int,
    quality: int,
) -> list[dict]:
    """Extract all preview frames for a segment in a single ffmpeg call.

    Uses the `select` filter to pick frames at the exact offsets corresponding
    to globally-aligned bucket timestamps. Frames are written to a temp
    directory, then renamed and moved to their final path.

    Returns list of frame metadata dicts on success.
    Falls back to per-frame extraction if the batch call fails.
    """
    if not buckets:
        return []

    offsets = [round(b - start_ts, 3) for b in buckets]
    n = len(offsets)

    # Build a select expression that picks frames at specified offsets.
    # We use gte(t, offset) conditions joined by OR so ffmpeg emits exactly
    # one frame per bucket (the first frame at or after each offset).
    # setpts=N/TB resets pts so -vframes N works correctly with -vsync vfr.
    select_expr = "+".join(f"gte(t,{o:.3f})*lte(t,{o+0.5:.3f})" for o in offsets)
    if _VAAPI_DEVICE:
        vf = f"select='{select_expr}',hwdownload,format=nv12,scale={width}:-1"
    else:
        vf = f"select='{select_expr}',scale={width}:-1"

    hw_flags = []
    if _VAAPI_DEVICE:
        hw_flags = ["-hwaccel", "vaapi", "-hwaccel_device", _VAAPI_DEVICE, "-hwaccel_output_format", "vaapi"]

    est_height = int(width * 9 / 16)
    results = []

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            out_pattern = str(tmp_path / "frame_%04d.jpg")

            cmd = [
                "nice", "-n", "19",
                "ionice", "-c", "3",
                "ffmpeg",
                "-v", "quiet",
                *hw_flags,
                "-i", str(video_path),
                "-vf", vf,
                "-vsync", "vfr",
                "-q:v", str(quality),
                "-vframes", str(n),
                "-y",
                out_pattern,
            ]

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

            if result.returncode != 0:
                log.debug(
                    "Batch ffmpeg failed for %s (rc=%d), falling back to per-frame",
                    video_path, result.returncode,
                )
                return _extract_frames_fallback(
                    video_path, buckets, start_ts, day_dir, width, quality
                )

            # Rename temp frames to bucket timestamps
            tmp_frames = sorted(tmp_path.glob("frame_*.jpg"))
            for i, (tmp_frame, bucket_ts) in enumerate(zip(tmp_frames, buckets)):
                filename = f"{bucket_ts:.2f}.jpg"
                final_path = day_dir / filename
                try:
                    shutil.move(str(tmp_frame), str(final_path))
                    rel_path = str(final_path.relative_to(settings.preview_output_path))
                    results.append({
                        "ts": bucket_ts,
                        "image_path": rel_path,
                        "width": width,
                        "height": est_height,
                    })
                except OSError as exc:
                    log.debug("Could not move frame %s: %s", tmp_frame, exc)

    except subprocess.TimeoutExpired:
        log.warning("Batch ffmpeg timed out for %s, falling back", video_path)
        return _extract_frames_fallback(
            video_path, buckets, start_ts, day_dir, width, quality
        )
    except Exception as exc:
        log.debug("Batch extraction error for %s: %s", video_path, exc)
        return _extract_frames_fallback(
            video_path, buckets, start_ts, day_dir, width, quality
        )

    return results


def _extract_frames_fallback(
    video_path: Path,
    buckets: list[float],
    start_ts: float,
    day_dir: Path,
    width: int,
    quality: int,
) -> list[dict]:
    """Per-frame fallback — one ffmpeg subprocess per bucket timestamp."""
    est_height = int(width * 9 / 16)
    results = []
    for bucket_ts in buckets:
        offset = round(bucket_ts - start_ts, 3)
        if offset < 0:
            continue
        filename = f"{bucket_ts:.2f}.jpg"
        output_path = day_dir / filename
        if output_path.exists():
            rel_path = str(output_path.relative_to(settings.preview_output_path))
            results.append({"ts": bucket_ts, "image_path": rel_path,
                            "width": width, "height": est_height})
            continue
        success = _extract_frame_at_offset(video_path, offset, output_path, width, quality)
        if success:
            rel_path = str(output_path.relative_to(settings.preview_output_path))
            results.append({"ts": bucket_ts, "image_path": rel_path,
                            "width": width, "height": est_height})
    return results


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
    hw_flags = []
    if _VAAPI_DEVICE:
        hw_flags = ["-hwaccel", "vaapi", "-hwaccel_device", _VAAPI_DEVICE, "-hwaccel_output_format", "vaapi"]

    if _VAAPI_DEVICE:
        vf_single = f"hwdownload,format=nv12,scale={width}:-1"
    else:
        vf_single = f"scale={width}:-1"

    cmd = [
        "nice", "-n", "19",
        "ionice", "-c", "3",
        "ffmpeg",
        "-v", "quiet",
        "-ss", f"{offset_sec:.3f}",
        *hw_flags,
        "-i", str(video_path),
        "-frames:v", "1",
        "-vf", vf_single,
        "-q:v", str(quality),
        "-y",
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
    target_bucket_ts: float | None = None,
) -> list[dict]:
    """Extract globally-aligned preview frames from a single segment.

    Returns list of dicts: {ts, image_path, width, height, segment_id, camera}

    target_bucket_ts:
        If provided, generate ONLY the preview for this specific bucket.
        The function generates at most one preview artifact in this mode.
        It does NOT generate previews for the full segment.
        Pass None for recency/background batch passes (existing behavior).
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

    if target_bucket_ts is not None:
        # Resolution-driven mode: at most one artifact.
        if start_ts <= target_bucket_ts <= end_ts + 0.5:
            buckets = [target_bucket_ts]
        else:
            return []  # bucket is outside this segment

    if not buckets:
        return []

    # Create output directory: {output_root}/{camera}/{YYYY-MM-DD}/
    dt = datetime.fromtimestamp(start_ts, tz=timezone.utc)
    day_dir = output_root / camera / dt.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)

    # Separate already-existing frames from those needing extraction
    missing_buckets = []
    existing_frames = []
    est_height = int(width * 9 / 16)

    for bucket_ts in buckets:
        if bucket_ts - start_ts < 0 or bucket_ts - start_ts > duration + 0.5:
            continue
        filename = f"{bucket_ts:.2f}.jpg"
        output_path = day_dir / filename
        if output_path.exists():
            rel_path = str(output_path.relative_to(output_root))
            existing_frames.append({
                "ts": bucket_ts,
                "image_path": rel_path,
                "width": width,
                "height": est_height,
                "segment_id": segment_id,
                "camera": camera,
            })
        else:
            missing_buckets.append(bucket_ts)

    if not missing_buckets:
        return existing_frames

    # Extract missing frames in one batch ffmpeg call
    new_frames = _extract_frames_batch(
        abs_path, missing_buckets, start_ts, day_dir, width, quality
    )

    # Annotate with segment_id and camera
    for f in new_frames:
        f["segment_id"] = segment_id
        f["camera"] = camera

    return existing_frames + new_frames


def process_pending_segments(
    db_path: Path | None = None,
    limit: int = 50,
    min_start_ts: float | None = None,
) -> int:
    """Process segments that don't have previews yet.

    Args:
        db_path:      Override database path (uses settings default if None).
        limit:        Maximum number of segments to process in this call.
        min_start_ts: If provided, only process segments with start_ts >= this
                      value. Used to implement recency-first prioritization.

    Returns number of segments processed.
    """
    db_path = db_path or settings.database_path

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    if min_start_ts is not None:
        rows = conn.execute(
            """SELECT id, camera, start_ts, end_ts, duration, path
               FROM segments
               WHERE previews_generated = 0 AND start_ts >= ?
               ORDER BY start_ts DESC
               LIMIT ?""",
            (min_start_ts, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT id, camera, start_ts, end_ts, duration, path
               FROM segments
               WHERE previews_generated = 0
               ORDER BY start_ts DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()

    if not rows:
        log.debug("No pending segments for preview generation (min_start_ts=%s)", min_start_ts)
        conn.close()
        return 0

    log.info(
        "Generating previews for %d segments%s",
        len(rows),
        f" (recency filter: {min_start_ts:.0f})" if min_start_ts else " (background crawl)",
    )
    processed = 0
    total_frames = 0
    start_time = time.time()

    def _process_single_segment(row, _db_path):
        """Process one segment and return (segment_id, frames). Thread-safe — uses its own sqlite3 connection."""
        frames = generate_previews_for_segment(
            segment_path=row["path"],
            camera=row["camera"],
            start_ts=row["start_ts"],
            end_ts=row["end_ts"],
            duration=row["duration"],
            segment_id=row["id"],
        )
        return row["id"], frames

    max_workers = min(settings.preview_workers, len(rows))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_process_single_segment, row, db_path): row for row in rows}
        for future in as_completed(futures):
            try:
                seg_id, frames = future.result()
            except Exception as exc:
                log.warning("Preview generation failed for segment: %s", exc)
                continue

            if frames:
                conn.executemany(
                    """INSERT OR IGNORE INTO previews
                       (camera, ts, segment_id, image_path, width, height)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    [(f["camera"], f["ts"], f["segment_id"],
                      f["image_path"], f["width"], f["height"]) for f in frames],
                )
                total_frames += len(frames)

            conn.execute(
                "UPDATE segments SET previews_generated = 1 WHERE id = ?", (seg_id,)
            )
            conn.commit()
            processed += 1

            if processed % 10 == 0:
                log.info("Progress: %d / %d segments", processed, len(rows))

    conn.close()
    elapsed = time.time() - start_time
    fps = total_frames / elapsed if elapsed > 0 else 0
    log.info(
        "Preview generation complete: %d segments, %d frames, %.1f frames/sec (%.1fs elapsed)",
        processed, total_frames, fps, elapsed,
    )
    return processed


def delete_old_previews(db_path: Path | None = None, retention_days: int | None = None) -> int:
    """Delete preview files and DB rows older than retention_days.

    Returns number of preview rows deleted.
    Runs in small batches to avoid disk I/O spikes.
    """
    db_path = db_path or settings.database_path
    retention_days = retention_days if retention_days is not None else settings.preview_retention_days

    if retention_days <= 0:
        return 0

    import time
    cutoff_ts = time.time() - retention_days * 86400
    output_root = settings.preview_output_path

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    batch_size = 500
    total_deleted = 0

    while True:
        rows = conn.execute(
            """SELECT p.id, p.image_path
               FROM previews p
               JOIN segments s ON p.segment_id = s.id
               WHERE s.start_ts < ?
               LIMIT ?""",
            (cutoff_ts, batch_size),
        ).fetchall()

        if not rows:
            break

        ids = [r["id"] for r in rows]
        for row in rows:
            file_path = output_root / row["image_path"]
            try:
                file_path.unlink(missing_ok=True)
            except OSError:
                pass

        conn.execute(
            f"DELETE FROM previews WHERE id IN ({','.join('?' * len(ids))})", ids
        )
        conn.commit()
        total_deleted += len(ids)

    conn.close()
    if total_deleted:
        log.info("Retention cleanup: deleted %d preview rows (cutoff=%d days)", total_deleted, retention_days)
    return total_deleted


async def process_pending_async(
    limit: int = 50,
    min_start_ts: float | None = None,
) -> int:
    """Async wrapper for preview generation."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, process_pending_segments, None, limit, min_start_ts
    )


async def delete_old_previews_async() -> int:
    """Async wrapper for retention cleanup."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, delete_old_previews)


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
