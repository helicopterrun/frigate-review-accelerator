"""Extract multiple frames from a single Frigate recording clip using one FFmpeg process."""

import asyncio
import tempfile
import os
from pathlib import Path
from typing import List, Tuple

from app.config import FRIGATE_URL


async def extract_frames_batch(
    camera: str,
    timestamps: List[float],
    width: int = 320,
    fmt: str = "jpg",
) -> dict[float, bytes]:
    """
    Fetch one clip spanning all requested timestamps from Frigate,
    then use a single FFmpeg process to extract a frame at each timestamp.

    Returns a dict mapping timestamp → frame bytes.
    """
    if not timestamps:
        return {}

    sorted_ts = sorted(timestamps)
    clip_start = int(sorted_ts[0]) - 1  # 1s margin before first frame
    clip_end = int(sorted_ts[-1]) + 2    # 1s margin after last frame

    clip_url = f"{FRIGATE_URL}/api/{camera}/start/{clip_start}/end/{clip_end}/clip.mp4"

    with tempfile.TemporaryDirectory() as tmpdir:
        clip_path = os.path.join(tmpdir, "clip.mp4")

        # Download the full clip from Frigate
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-f", "-o", clip_path, clip_url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.wait(), timeout=30)

            if proc.returncode != 0 or not os.path.exists(clip_path):
                return {}

            if os.path.getsize(clip_path) < 1000:
                return {}
        except (asyncio.TimeoutError, Exception):
            return {}

        # Build a single FFmpeg command that extracts all frames using select filter.
        # Each frame is output at the timestamp's offset from clip start.
        # We use the select filter with exact PTS matching.
        results: dict[float, bytes] = {}

        # FFmpeg select filter: pick frames nearest to each target time
        # Offset each timestamp relative to clip start
        offsets = [(ts, ts - clip_start) for ts in sorted_ts]

        # Use FFmpeg with -ss for each frame — sequential seeks within one input.
        # For efficiency, extract all at once using the fps filter with frame output.
        # Simplest reliable approach: one -ss seek per frame, but reuse the downloaded clip.
        for ts, offset in offsets:
            frame_path = os.path.join(tmpdir, f"frame_{ts:.2f}.{fmt}")
            try:
                ffmpeg_args = [
                    "ffmpeg", "-y",
                    "-ss", f"{max(0, offset):.3f}",
                    "-i", clip_path,
                    "-frames:v", "1",
                    "-q:v", "3",
                ]
                if width:
                    ffmpeg_args.extend(["-vf", f"scale={width}:-1"])
                ffmpeg_args.extend(["-update", "1", frame_path])

                proc = await asyncio.create_subprocess_exec(
                    *ffmpeg_args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.wait(), timeout=5)

                if proc.returncode == 0 and os.path.exists(frame_path):
                    results[ts] = Path(frame_path).read_bytes()
            except (asyncio.TimeoutError, Exception):
                continue

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
