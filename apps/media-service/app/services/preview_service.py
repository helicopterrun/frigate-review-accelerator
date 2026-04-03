"""
Preview strip: N evenly-spaced frames from a time range composed into a
single horizontal WebP filmstrip.

Used for the scrub-preview hover effect in the VideoPlayer when the user
hovers over the timeline during SCRUB_REVIEW mode.
"""

import hashlib
import io
import os
from pathlib import Path

from PIL import Image

from app.config import MEDIA_CACHE_DIR
from app.services.ffmpeg_extractor import extract_frames_batch

PREVIEW_CACHE_DIR = os.path.join(MEDIA_CACHE_DIR, "preview")
FRAME_W = 120   # thumbnail width per frame
FRAME_H = 68    # thumbnail height (16:9 at 120 px wide)


def _strip_cache_key(camera: str, start_time: float, end_time: float, count: int) -> str:
    raw = f"{camera}:{start_time:.0f}:{end_time:.0f}:{count}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _strip_cache_path(camera: str, start_time: float, end_time: float, count: int) -> str:
    key = _strip_cache_key(camera, start_time, end_time, count)
    return os.path.join(PREVIEW_CACHE_DIR, camera, f"strip_{key}.webp")


def _cached_strip_url(
    camera: str, start_time: float, end_time: float, count: int
) -> str | None:
    path = _strip_cache_path(camera, start_time, end_time, count)
    if os.path.exists(path):
        rel = os.path.relpath(path, MEDIA_CACHE_DIR)
        return f"/media/{rel}"
    return None


def _evenly_spaced(start: float, end: float, count: int) -> list[float]:
    if count == 1:
        return [(start + end) / 2]
    step = (end - start) / (count - 1)
    return [start + i * step for i in range(count)]


def _compose_strip(frames_data: dict[float, bytes], timestamps: list[float]) -> bytes:
    """Compose extracted frame bytes into a horizontal filmstrip WebP."""
    pil_frames: list[Image.Image] = []
    for ts in timestamps:
        raw = frames_data.get(ts)
        if raw:
            try:
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                img = img.resize((FRAME_W, FRAME_H), Image.LANCZOS)
            except Exception:
                img = Image.new("RGB", (FRAME_W, FRAME_H), (30, 34, 40))
        else:
            img = Image.new("RGB", (FRAME_W, FRAME_H), (30, 34, 40))
        pil_frames.append(img)

    strip = Image.new("RGB", (FRAME_W * len(pil_frames), FRAME_H))
    for i, frame in enumerate(pil_frames):
        strip.paste(frame, (i * FRAME_W, 0))

    buf = io.BytesIO()
    strip.save(buf, format="WEBP", quality=75)
    return buf.getvalue()


async def build_preview_strip(
    camera: str,
    start_time: float,
    end_time: float,
    count: int = 12,
) -> dict:
    cached_url = _cached_strip_url(camera, start_time, end_time, count)
    if cached_url:
        return {
            "ok": True,
            "url": cached_url,
            "camera": camera,
            "start_time": start_time,
            "end_time": end_time,
            "frame_count": count,
        }

    timestamps = _evenly_spaced(start_time, end_time, count)

    # extract_frames_batch skips extraction when tDiv >= 300s.
    # For preview strips the tDiv is (end-start)/(count-1) which is typically
    # well under 300s, so frames will always be extracted.
    frames_data = await extract_frames_batch(camera, timestamps, width=FRAME_W)

    strip_bytes = _compose_strip(frames_data, timestamps)

    out_path = _strip_cache_path(camera, start_time, end_time, count)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Path(out_path).write_bytes(strip_bytes)

    rel = os.path.relpath(out_path, MEDIA_CACHE_DIR)
    url = f"/media/{rel}"

    return {
        "ok": True,
        "url": url,
        "camera": camera,
        "start_time": start_time,
        "end_time": end_time,
        "frame_count": count,
    }
