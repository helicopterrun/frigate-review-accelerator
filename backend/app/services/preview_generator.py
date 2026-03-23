"""Preview Frame Generator — extracts JPEG thumbnails from recording segments.

Single-frame extraction model (v3):

  extract_preview_frame(camera, ts, width, quality, segment=None)

  - Resolves the segment containing ts (or uses the caller-supplied row)
  - Builds the O(1) bucket path: {preview_output_path}/{camera}/{YYYY-MM-DD}/{ts:.2f}.jpg
  - Returns immediately if the file already exists (no ffmpeg call)
  - Runs exactly ONE ffmpeg subprocess with -frames:v 1
  - Returns None on any failure — no retries, no fallback loops
  - Is synchronous (sqlite3, not aiosqlite) — runs in a thread pool executor

Output structure:
  {preview_output_path}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
"""

import logging
import os
import shutil
import sqlite3
import subprocess
import subprocess as _sp
import threading
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from app.config import settings

log = logging.getLogger(__name__)


def _write_preview_failure_reason(segment_id: int, reason: str) -> None:
    """Record the reason a preview extraction failed for this segment."""
    try:
        conn = sqlite3.connect(str(settings.database_path))
        conn.execute(
            "UPDATE segments SET preview_failure_reason = ? WHERE id = ?",
            (reason, segment_id),
        )
        conn.commit()
        conn.close()
    except Exception as exc:
        log.debug("Could not write preview_failure_reason for segment %d: %s", segment_id, exc)


def _clear_preview_failure_reason(segment_id: int) -> None:
    """Clear the failure reason after a successful extraction."""
    try:
        conn = sqlite3.connect(str(settings.database_path))
        conn.execute(
            "UPDATE segments SET preview_failure_reason = NULL WHERE id = ?",
            (segment_id,),
        )
        conn.commit()
        conn.close()
    except Exception as exc:
        log.debug("Could not clear preview_failure_reason for segment %d: %s", segment_id, exc)


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


# Lazy VAAPI probe — not evaluated at import time to avoid stalling startup.
# 'unchecked' is the sentinel meaning the probe has not yet run.
_VAAPI_DEVICE: str | None = "unchecked"  # type: ignore[assignment]
_VAAPI_LOCK = threading.Lock()


def _get_vaapi_device() -> str | None:
    """Return the VAAPI device path, probing on first call (lazy init).

    Uses double-checked locking so the probe runs exactly once even when
    multiple worker threads call this simultaneously on startup.
    """
    global _VAAPI_DEVICE
    if _VAAPI_DEVICE != "unchecked":
        return _VAAPI_DEVICE  # type: ignore[return-value]
    with _VAAPI_LOCK:
        if _VAAPI_DEVICE != "unchecked":  # double-checked locking
            return _VAAPI_DEVICE  # type: ignore[return-value]
        _VAAPI_DEVICE = _vaapi_device()
        if _VAAPI_DEVICE:
            log.info("VAAPI hardware decode enabled (%s)", _VAAPI_DEVICE)
        else:
            log.info("VAAPI not available, using software decode")
        return _VAAPI_DEVICE  # type: ignore[return-value]


# Serialize VAAPI access — a single iGPU does not parallelize across
# concurrent ffmpeg processes.  Software-decode workers are not gated.
_VAAPI_MAX_CONCURRENT = 1
_vaapi_semaphore = threading.Semaphore(_VAAPI_MAX_CONCURRENT)


def extract_preview_frame(
    camera: str,
    ts: float,
    width: int,
    quality: int,
    segment: dict | None = None,
) -> dict | None:
    """Extract a single preview JPEG at the given timestamp.

    Args:
        camera:  Camera name.
        ts:      Bucket timestamp (globally aligned, e.g. round(t/2)*2).
        width:   Output image width in pixels.
        quality: ffmpeg JPEG quality (1–31, lower = better).
        segment: Optional pre-resolved segment dict with keys
                 (id, camera, start_ts, end_ts, duration, path).
                 If None, the segment is looked up from the DB.

    Returns a metadata dict on success, None on any failure.
    One ffmpeg call, no retries, no fallback loops.
    """
    result = None  # keep in scope for the failure branch

    # Step 1 — Resolve segment
    if segment is None:
        conn = sqlite3.connect(str(settings.database_path))
        row = conn.execute(
            """SELECT id, camera, start_ts, end_ts, duration, path
               FROM segments
               WHERE camera = ? AND start_ts <= ? AND end_ts > ?
               LIMIT 1""",
            (camera, ts, ts),
        ).fetchone()
        conn.close()
        if row is None:
            return None
        segment = {
            "id": row[0], "camera": row[1], "start_ts": row[2],
            "end_ts": row[3], "duration": row[4], "path": row[5],
        }

    # Step 2 — Build output path
    offset = max(0.0, ts - segment["start_ts"])
    abs_path = settings.frigate_recordings_path / segment["path"]
    if not abs_path.exists():
        return None

    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    day_dir = settings.preview_output_path / camera / dt.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{ts:.2f}.jpg"
    output_path = day_dir / filename

    if output_path.exists():
        # Read actual output dimensions — do not assume 16:9.
        # ffmpeg scale={width}:-1 preserves source aspect ratio, so cameras
        # that are not 16:9 (e.g. Ubiquiti 4:3) will produce a different height.
        # PIL header-only open is O(1) — it reads only the JPEG SOF marker.
        actual_width = width
        actual_height = int(width * 9 / 16)  # safe fallback if PIL read fails
        try:
            with Image.open(output_path) as _img:
                actual_width, actual_height = _img.size
        except Exception:
            pass  # fallback to 16:9 estimate — non-fatal
        return {
            "ts": ts,
            "camera": camera,
            "segment_id": segment["id"],
            "image_path": str(output_path.relative_to(settings.preview_output_path)),
            "width": actual_width,
            "height": actual_height,
        }

    # Step 3 — Run exactly ONE ffmpeg subprocess
    vaapi_dev = _get_vaapi_device()
    hw_flags: list[str] = []
    if vaapi_dev:
        hw_flags = [
            "-hwaccel", "vaapi",
            "-hwaccel_device", vaapi_dev,
            "-hwaccel_output_format", "vaapi",
        ]

    if vaapi_dev:
        vf = f"hwdownload,format=nv12,scale={width}:-1"
    else:
        vf = f"scale={width}:-1"

    cmd = [
        "nice", "-n", "19",
        "ionice", "-c", "3",
        "ffmpeg",
        "-v", "quiet",
        "-ss", f"{offset:.3f}",
        *hw_flags,
        "-i", str(abs_path),
        "-frames:v", "1",
        "-vf", vf,
        "-q:v", str(quality),
        "-y",
        str(output_path),
    ]

    try:
        if vaapi_dev:
            with _vaapi_semaphore:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        else:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        log.debug("Preview extraction timed out for %s ts=%.2f", camera, ts)
        _write_preview_failure_reason(segment["id"], "timeout")
        return None
    except Exception as exc:
        log.debug("Preview extraction error for %s ts=%.2f: %s", camera, ts, exc)
        _write_preview_failure_reason(segment["id"], "exception")
        return None

    # Step 4 — Return result or None
    if result.returncode == 0 and output_path.exists():
        # Read actual output dimensions — do not assume 16:9.
        # ffmpeg scale={width}:-1 preserves source aspect ratio, so cameras
        # that are not 16:9 (e.g. Ubiquiti 4:3) will produce a different height.
        # PIL header-only open is O(1) — it reads only the JPEG SOF marker.
        actual_width = width
        actual_height = int(width * 9 / 16)  # safe fallback if PIL read fails
        try:
            with Image.open(output_path) as _img:
                actual_width, actual_height = _img.size
        except Exception:
            pass  # fallback to 16:9 estimate — non-fatal
        _clear_preview_failure_reason(segment["id"])
        return {
            "ts": ts,
            "camera": camera,
            "segment_id": segment["id"],
            "image_path": str(output_path.relative_to(settings.preview_output_path)),
            "width": actual_width,
            "height": actual_height,
        }

    log.debug("Preview extraction failed for %s ts=%.2f", camera, ts)
    if result is not None and result.stderr:
        log.debug("ffmpeg stderr: %s", result.stderr[-500:])
    # Classify the failure reason for diagnostics
    if result is not None and result.returncode != 0:
        stderr_lower = (result.stderr or "").lower()
        reason = "vaapi_decode_error" if "vaapi" in stderr_lower else "ffmpeg_nonzero_exit"
    else:
        reason = "output_not_written"
    _write_preview_failure_reason(segment["id"], reason)
    return None


def delete_old_previews(db_path: Path | None = None, retention_days: int | None = None) -> int:
    """Delete preview files and DB rows older than retention_days.

    Returns number of preview rows deleted.
    Runs in small batches to avoid disk I/O spikes.
    """
    import time
    db_path = db_path or settings.database_path
    retention_days = retention_days if retention_days is not None else settings.preview_retention_days

    if retention_days <= 0:
        return 0

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


async def delete_old_previews_async() -> int:
    """Async wrapper for retention cleanup."""
    import asyncio
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, delete_old_previews)
