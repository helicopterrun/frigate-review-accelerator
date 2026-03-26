"""Extract multiple frames from Frigate recordings using FFmpeg.

For efficiency, timestamps are grouped into segments. Each segment
downloads one short clip from Frigate (covering just the timestamps
in that group) and runs FFmpeg seeks within it.
"""

import asyncio
import tempfile
import os
from pathlib import Path
from typing import List

from app.config import FRIGATE_URL

# Max seconds per clip segment — keeps downloads fast
MAX_SEGMENT_SEC = 120


def _group_timestamps(timestamps: List[float]) -> List[List[float]]:
    """Group sorted timestamps into segments where each segment spans <= MAX_SEGMENT_SEC."""
    if not timestamps:
        return []

    sorted_ts = sorted(timestamps)
    groups: List[List[float]] = [[sorted_ts[0]]]

    for ts in sorted_ts[1:]:
        if ts - groups[-1][0] <= MAX_SEGMENT_SEC:
            groups[-1].append(ts)
        else:
            groups.append([ts])

    return groups


async def _download_clip(camera: str, start: int, end: int, dest: str) -> bool:
    """Download a clip from Frigate's recording API."""
    clip_url = f"{FRIGATE_URL}/api/{camera}/start/{start}/end/{end}/clip.mp4"
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-f", "-o", dest, clip_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=15)
        return proc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 1000
    except (asyncio.TimeoutError, Exception):
        return False


async def _extract_frame(clip_path: str, offset: float, out_path: str, width: int) -> bool:
    """Extract a single frame from a clip at the given offset."""
    ffmpeg_args = [
        "ffmpeg", "-y",
        "-ss", f"{max(0, offset):.3f}",
        "-i", clip_path,
        "-frames:v", "1",
        "-q:v", "3",
    ]
    if width:
        ffmpeg_args.extend(["-vf", f"scale={width}:-1"])
    ffmpeg_args.extend(["-update", "1", out_path])

    try:
        proc = await asyncio.create_subprocess_exec(
            *ffmpeg_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.wait(), timeout=5)
        return proc.returncode == 0 and os.path.exists(out_path)
    except (asyncio.TimeoutError, Exception):
        return False


async def extract_frames_batch(
    camera: str,
    timestamps: List[float],
    width: int = 320,
    fmt: str = "jpg",
) -> dict[float, bytes]:
    """
    Extract frames from Frigate recordings. Timestamps are grouped into
    segments of <= 2 minutes. Each segment downloads one short clip and
    runs FFmpeg seeks within it. Much more efficient than one giant clip.
    """
    if not timestamps:
        return {}

    groups = _group_timestamps(timestamps)
    results: dict[float, bytes] = {}

    with tempfile.TemporaryDirectory() as tmpdir:
        # Process segments concurrently (up to 4 at a time)
        sem = asyncio.Semaphore(4)

        async def process_segment(group: List[float], seg_idx: int):
            async with sem:
                clip_start = int(min(group)) - 1
                clip_end = int(max(group)) + 2
                clip_path = os.path.join(tmpdir, f"seg_{seg_idx}.mp4")

                if not await _download_clip(camera, clip_start, clip_end, clip_path):
                    return

                for ts in group:
                    offset = ts - clip_start
                    frame_path = os.path.join(tmpdir, f"frame_{ts:.2f}.{fmt}")
                    if await _extract_frame(clip_path, offset, frame_path, width):
                        results[ts] = Path(frame_path).read_bytes()

        await asyncio.gather(
            *(process_segment(group, i) for i, group in enumerate(groups))
        )

    return results


async def extract_single_frame(
    camera: str,
    timestamp: float,
    width: int = 320,
    fmt: str = "jpg",
) -> bytes | None:
    """Convenience wrapper for extracting a single frame."""
    results = await extract_frames_batch(camera, [timestamp], width, fmt)
    return results.get(timestamp)
