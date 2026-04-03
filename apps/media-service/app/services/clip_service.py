"""
Clip preparation: concat Frigate recording segments into a playable MP4.

Strategy:
  1. Scan for local recording segments covering [start_time, end_time]
  2. If found: FFmpeg concat + trim → cached MP4
  3. If not: fall back to Frigate HTTP clip API

The output is cached under {MEDIA_CACHE_DIR}/clips/{camera}/ by a hash of the
request parameters so repeated requests are instant.
"""

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Optional

from app.config import FRIGATE_URL, MEDIA_CACHE_DIR
from app.services.ffmpeg_extractor import RECORDINGS_DIR, _find_local_file

CLIP_CACHE_DIR = os.path.join(MEDIA_CACHE_DIR, "clips")
CLIP_API_TIMEOUT = 60.0   # seconds — Frigate HTTP clip generation can be slow
LOCAL_CONCAT_TIMEOUT = 60.0


# ── Cache helpers ─────────────────────────────────────────────────────────────

def _clip_cache_key(camera: str, start_time: float, end_time: float) -> str:
    raw = f"{camera}:{start_time:.0f}:{end_time:.0f}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _clip_out_path(camera: str, start_time: float, end_time: float) -> str:
    key = _clip_cache_key(camera, start_time, end_time)
    return os.path.join(CLIP_CACHE_DIR, camera, f"clip_{key}.mp4")


def _cached_clip_url(camera: str, start_time: float, end_time: float) -> Optional[str]:
    path = _clip_out_path(camera, start_time, end_time)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        rel = os.path.relpath(path, MEDIA_CACHE_DIR)
        return f"/media/{rel}"
    return None


# ── Local segment concat ──────────────────────────────────────────────────────

def _collect_segments(
    camera: str, start_time: float, end_time: float
) -> list[tuple[str, float]]:
    """
    Find all local recording segments that overlap [start_time, end_time].
    Returns a sorted list of (file_path, segment_start_ts).
    """
    seen: set[str] = set()
    segments: list[tuple[str, float]] = []

    # Step through the range in ~9-second increments to catch every segment
    scan_ts = start_time
    while scan_ts <= end_time + 10:
        found = _find_local_file(camera, scan_ts)
        if found:
            file_path, file_start = found
            if file_path not in seen:
                seen.add(file_path)
                segments.append((file_path, file_start))
        scan_ts += 9.0

    return sorted(segments, key=lambda x: x[1])


async def _concat_local(
    camera: str, start_time: float, end_time: float, out_path: str
) -> bool:
    segments = _collect_segments(camera, start_time, end_time)
    if not segments:
        return False

    first_seg_start = segments[0][1]
    trim_offset = max(0.0, start_time - first_seg_start)
    duration = end_time - start_time

    tmp_list = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False
        ) as f:
            for seg_path, _ in segments:
                f.write(f"file '{seg_path}'\n")
            tmp_list = f.name

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", tmp_list,
            "-ss", f"{trim_offset:.3f}",
            "-t", f"{duration:.3f}",
            "-c", "copy",
            "-movflags", "+faststart",
            out_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=LOCAL_CONCAT_TIMEOUT)
        return (
            proc.returncode == 0
            and os.path.exists(out_path)
            and os.path.getsize(out_path) > 0
        )
    except Exception:
        return False
    finally:
        if tmp_list and os.path.exists(tmp_list):
            os.unlink(tmp_list)


# ── HTTP fallback ─────────────────────────────────────────────────────────────

async def _download_from_frigate(
    camera: str, start_time: float, end_time: float, out_path: str
) -> bool:
    url = (
        f"{FRIGATE_URL}/api/{camera}"
        f"/start/{int(start_time)}/end/{int(end_time)}/clip.mp4"
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-f", "--max-time", "30", "-o", out_path, url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=CLIP_API_TIMEOUT)
        return (
            proc.returncode == 0
            and os.path.exists(out_path)
            and os.path.getsize(out_path) > 0
        )
    except Exception:
        return False


# ── Public API ────────────────────────────────────────────────────────────────

async def prepare_clip(
    camera: str, start_time: float, end_time: float
) -> dict:
    # Return cached result immediately
    cached_url = _cached_clip_url(camera, start_time, end_time)
    if cached_url:
        return {
            "ok": True,
            "clip_url": cached_url,
            "status": "ready",
            "source": "cache",
            "duration_sec": end_time - start_time,
        }

    out_path = _clip_out_path(camera, start_time, end_time)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Try local recording concat first (fast, no network)
    if await _concat_local(camera, start_time, end_time, out_path):
        rel = os.path.relpath(out_path, MEDIA_CACHE_DIR)
        return {
            "ok": True,
            "clip_url": f"/media/{rel}",
            "status": "ready",
            "source": "local_concat",
            "duration_sec": end_time - start_time,
        }

    # Fall back to Frigate HTTP clip API
    if await _download_from_frigate(camera, start_time, end_time, out_path):
        rel = os.path.relpath(out_path, MEDIA_CACHE_DIR)
        return {
            "ok": True,
            "clip_url": f"/media/{rel}",
            "status": "ready",
            "source": "frigate_http",
            "duration_sec": end_time - start_time,
        }

    return {
        "ok": False,
        "clip_url": None,
        "status": "unavailable",
        "error": "No recording found for this camera and time range",
    }
