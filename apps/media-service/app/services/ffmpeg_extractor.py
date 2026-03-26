"""Extract a single frame from a Frigate recording clip using FFmpeg."""

import asyncio
import tempfile
import os
from pathlib import Path

from app.config import FRIGATE_URL


async def extract_frame_from_recording(
    camera: str,
    timestamp: float,
    width: int = 320,
    fmt: str = "jpg",
) -> bytes | None:
    """
    Fetch a 2-second clip from Frigate centered on the timestamp,
    then use FFmpeg to extract the first frame as JPEG.
    """
    start_ts = int(timestamp)
    end_ts = start_ts + 2  # 2-second clip is enough for 1 frame

    clip_url = f"{FRIGATE_URL}/api/{camera}/start/{start_ts}/end/{end_ts}/clip.mp4"

    with tempfile.TemporaryDirectory() as tmpdir:
        clip_path = os.path.join(tmpdir, "clip.mp4")
        frame_path = os.path.join(tmpdir, f"frame.{fmt}")

        # Download clip from Frigate
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-f", "-o", clip_path, clip_url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.wait(), timeout=10)

            if proc.returncode != 0 or not os.path.exists(clip_path):
                return None

            clip_size = os.path.getsize(clip_path)
            if clip_size < 1000:  # Too small to be a valid clip
                return None
        except (asyncio.TimeoutError, Exception):
            return None

        # Extract first frame with FFmpeg, scaled to requested width
        try:
            ffmpeg_args = [
                "ffmpeg", "-y",
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
            await asyncio.wait_for(proc.wait(), timeout=10)

            if proc.returncode != 0 or not os.path.exists(frame_path):
                return None

            return Path(frame_path).read_bytes()
        except (asyncio.TimeoutError, Exception):
            return None
