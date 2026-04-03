"""
Frame extraction using direct access to Frigate's recording files.

Frigate stores recordings at:
  {RECORDINGS_DIR}/{YYYY-MM-DD}/{HH}/{camera}/{MM}.{SS}.mp4

where date/hour are UTC and MM.SS is the exact start time of each
~10-second segment.  Accessing files directly bypasses the Frigate HTTP
API entirely and lets FFmpeg seek in local storage.

Timing comparison for street-doorbell:
  HTTP clip API   (10 s clip)   ~0.60 s / slot
  HLS segment     (2.2 MB m4s)  ~0.31 s / slot  + Frigate throttles at >8 concurrent
  Local file seek (10 s mp4)    ~0.17 s / slot  no network, 8 concurrent → ~1.4 s total

Strategy:
  tDiv < 300 s   Direct local file seek, up to SEEK_CONCURRENCY parallel FFmpeg
                 processes.  Falls back to HTTP clip API if a local file is not
                 found (e.g. gap in recording, or recordings not mounted).
  tDiv ≥ 300 s   No extraction.  At 5-minute+ slot widths the TypeB resolver
                 (Frigate event snapshots) owns every slot; empty slots use a
                 placeholder from the caller.
"""

import asyncio
import os
import statistics
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional

from app.config import FRIGATE_URL

# Directory where Frigate's recording segments live on the host filesystem.
# Override with RECORDINGS_DIR env var if the mount point differs.
RECORDINGS_DIR: str = os.environ.get(
    "RECORDINGS_DIR", "/mnt/frigate-storage/recordings/recordings"
)

TDIV_NO_EXTRACTION: float = 300.0   # seconds — above this, return {} (Type B handles it)
SEEK_CONCURRENCY:   int   = os.cpu_count() or 4   # one FFmpeg per core is optimal
CLIP_API_TIMEOUT:   float = 10.0    # seconds — for HTTP fallback only

# For Tier 2, when the slot duration is wide enough that using the first
# frame of the segment (offset=0) is accurate enough, skip seeking
# to an arbitrary offset — the first I-frame is fastest to decode.
# Rule: acceptable if max error (≤ segment_duration=10 s) < tDiv / 2.
OFFSET_ZERO_TDIV_THRESHOLD: float = 20.0   # seconds


# ── recording file lookup ─────────────────────────────────────────────────────

def _file_start_ts(path: str) -> float:
    """
    Parse the start timestamp from a recording file path.
    Path must end in  .../YYYY-MM-DD/HH/camera/MM.SS.mp4
    """
    parts   = path.replace("\\", "/").split("/")
    fname   = parts[-1][:-4]          # strip .mp4
    camera  = parts[-2]               # (unused but validates depth)
    hh      = parts[-3]
    ymd     = parts[-4]
    mm_s, ss_s = fname.split(".")
    dt = datetime.strptime(
        f"{ymd} {hh}:{mm_s}:{ss_s}", "%Y-%m-%d %H:%M:%S"
    ).replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _find_local_file(camera: str, timestamp: float) -> Optional[tuple[str, float]]:
    """
    Return (file_path, file_start_ts) for the recording segment that
    covers *timestamp*, or None if no local file is found.

    Checks the directory for the current UTC hour and the previous hour
    (to handle segments that straddle an hour boundary).
    """
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)

    for hour_delta in (0, -1):
        dt_dir    = dt + timedelta(hours=hour_delta)
        ymd       = dt_dir.strftime("%Y-%m-%d")
        hh        = dt_dir.strftime("%H")
        dir_path  = os.path.join(RECORDINGS_DIR, ymd, hh, camera)
        if not os.path.isdir(dir_path):
            continue

        hour_epoch = dt_dir.replace(minute=0, second=0, microsecond=0).timestamp()

        try:
            files = sorted(f for f in os.listdir(dir_path) if f.endswith(".mp4"))
        except OSError:
            continue

        # Walk backwards so the first match is the latest start ≤ timestamp.
        for fname in reversed(files):
            try:
                mm_s, ss_s = fname[:-4].split(".")
                file_ts = hour_epoch + int(mm_s) * 60 + int(ss_s)
            except ValueError:
                continue
            # Accept if timestamp falls within a 15-second window from file start
            # (typical segment is ~10 s; 15 s gives a comfortable margin).
            if file_ts <= timestamp < file_ts + 15:
                return os.path.join(dir_path, fname), file_ts

    return None


# ── FFmpeg helpers ────────────────────────────────────────────────────────────

async def _seek_frame(source: str, offset_sec: float, out_path: str, width: int) -> bool:
    """Extract one frame from *source* at *offset_sec*."""
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{max(0.0, offset_sec):.3f}",
        "-i", source,
        "-frames:v", "1",
        "-q:v", "3",
        "-vf", f"scale={width}:-1",
        "-update", "1",
        out_path,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=5.0)
        return proc.returncode == 0 and os.path.exists(out_path)
    except Exception:
        return False


async def _http_clip_fallback(
    camera: str, timestamp: float, width: int, fmt: str, tmpdir: str
) -> Optional[bytes]:
    """
    HTTP fallback: download a 10-second clip from Frigate and extract one
    frame.  Used when the local recording file is not found (e.g. gap,
    different mount, or permissions issue).
    """
    clip_start = int(timestamp) - 1
    clip_end   = clip_start + 11
    clip_url   = f"{FRIGATE_URL}/api/{camera}/start/{clip_start}/end/{clip_end}/clip.mp4"
    clip_path  = os.path.join(tmpdir, f"clip_{timestamp:.0f}.mp4")
    out_path   = os.path.join(tmpdir, f"fb_{timestamp:.3f}.{fmt}")

    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-f", "-o", clip_path, clip_url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=CLIP_API_TIMEOUT)
        if proc.returncode != 0:
            return None
    except Exception:
        return None

    if await _seek_frame(clip_path, timestamp - clip_start, out_path, width):
        return Path(out_path).read_bytes()
    return None


# ── public API ────────────────────────────────────────────────────────────────

def _infer_tdiv(timestamps: List[float]) -> float:
    if len(timestamps) < 2:
        return 0.0
    diffs = [timestamps[i + 1] - timestamps[i] for i in range(len(timestamps) - 1)]
    return statistics.median(diffs)


async def extract_frames_batch(
    camera: str,
    timestamps: List[float],
    width: int = 320,
    fmt: str = "jpg",
) -> "dict[float, bytes]":
    """
    Extract frames for a list of slot-center timestamps.

    Uses direct local filesystem access to Frigate's recording segments for
    fast parallel seeks.  Falls back to the Frigate HTTP clip API for any
    timestamp whose local file is not found.

    Returns {timestamp: jpeg_bytes}; missing entries mean no recording was
    available (caller applies a mock placeholder).
    """
    if not timestamps:
        return {}

    tDiv = _infer_tdiv(timestamps)
    if tDiv >= TDIV_NO_EXTRACTION:
        return {}  # Type B resolver handles wide zoom

    seek_sem = asyncio.Semaphore(SEEK_CONCURRENCY)
    results: "dict[float, bytes]" = {}

    # For wide-zoom slots, grabbing the first I-frame (offset=0) avoids
    # expensive mid-segment seeks and is accurate enough when tDiv >> 10 s.
    use_offset_zero = tDiv >= OFFSET_ZERO_TDIV_THRESHOLD

    with tempfile.TemporaryDirectory() as tmpdir:

        async def one(ts: float) -> None:
            out_path = os.path.join(tmpdir, f"f_{ts:.3f}.{fmt}")

            found = _find_local_file(camera, ts)
            if found:
                file_path, file_start = found
                offset = 0.0 if use_offset_zero else ts - file_start
                async with seek_sem:
                    if await _seek_frame(file_path, offset, out_path, width):
                        results[ts] = Path(out_path).read_bytes()
                        return

            # Local file not found — HTTP fallback (recording gap or mount issue)
            async with seek_sem:
                data = await _http_clip_fallback(camera, ts, width, fmt, tmpdir)
                if data:
                    results[ts] = data

        await asyncio.gather(*(one(ts) for ts in timestamps))

    return results


async def extract_single_frame(
    camera: str,
    timestamp: float,
    width: int = 320,
    fmt: str = "jpg",
) -> "bytes | None":
    results = await extract_frames_batch(camera, [timestamp], width, fmt)
    return results.get(timestamp)
