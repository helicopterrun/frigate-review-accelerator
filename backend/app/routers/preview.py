"""Preview API — serves preview frames for timeline scrubbing.

This is the HOT PATH. Every pixel of mouse movement during a scrub
fires a request here. Performance budget: <50ms end-to-end.

v2 changes:
  - Bucket-based O(1) lookup: no DB query per scrub event
    ts → quantize to interval → build filesystem path directly
  - LRU memory cache: last N images held in RAM as bytes
    eliminates disk I/O for recent scrub positions
  - DB is only used for the /preview-strip batch endpoint (cold path)

The key insight: preview filenames ARE the timestamp (e.g. 1700000002.00.jpg).
So lookup is just math + path construction. No index needed.
"""

import math
import logging
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models.database import get_db
from app.models.schemas import PreviewFrame, PreviewStrip

router = APIRouter(prefix="/api", tags=["preview"])
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# LRU image cache
# ---------------------------------------------------------------------------
class ImageCache:
    """Thread-safe LRU cache for preview JPEG bytes.

    Keyed by (camera, bucket_ts). Holds raw bytes so we can
    return a Response without touching disk.

    Memory budget: 500 images × ~15KB avg = ~7.5MB
    """

    def __init__(self, max_size: int = 500):
        self._cache: OrderedDict[tuple[str, float], bytes] = OrderedDict()
        self._max = max_size
        self.hits = 0
        self.misses = 0

    def get(self, camera: str, bucket_ts: float) -> bytes | None:
        key = (camera, bucket_ts)
        if key in self._cache:
            self._cache.move_to_end(key)
            self.hits += 1
            return self._cache[key]
        self.misses += 1
        return None

    def put(self, camera: str, bucket_ts: float, data: bytes):
        key = (camera, bucket_ts)
        self._cache[key] = data
        self._cache.move_to_end(key)
        while len(self._cache) > self._max:
            self._cache.popitem(last=False)

    @property
    def size(self) -> int:
        return len(self._cache)

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return (self.hits / total * 100) if total > 0 else 0.0


_cache = ImageCache(max_size=500)


# ---------------------------------------------------------------------------
# Bucket math
# ---------------------------------------------------------------------------
def _quantize_ts(ts: float, interval: float) -> float:
    """Snap a timestamp to the nearest preview bucket.

    >>> _quantize_ts(1700000003.7, 2.0)
    1700000004.0
    """
    return round(ts / interval) * interval


def _bucket_path(camera: str, bucket_ts: float) -> Path:
    """Build the filesystem path for a bucketed preview frame.

    Structure: {preview_root}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
    """
    dt = datetime.fromtimestamp(bucket_ts, tz=timezone.utc)
    date_dir = dt.strftime("%Y-%m-%d")
    filename = f"{bucket_ts:.2f}.jpg"
    return settings.preview_output_path / camera / date_dir / filename


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/preview/{camera}/{timestamp}")
async def get_preview_frame(camera: str, timestamp: float):
    """Get the nearest preview frame — O(1), no DB.

    Hot path during scrubbing:
      1. Quantize timestamp to nearest bucket
      2. Check LRU memory cache → return bytes if hit
      3. Build filesystem path → read + cache + return
      4. If exact bucket missing, try ±1 bucket (jitter tolerance)

    Returns JPEG bytes with aggressive cache headers.
    """
    interval = settings.preview_interval_sec
    bucket_ts = _quantize_ts(timestamp, interval)

    # 1. Memory cache check
    cached = _cache.get(camera, bucket_ts)
    if cached is not None:
        return Response(
            content=cached,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Preview-Timestamp": f"{bucket_ts:.2f}",
                "X-Cache": "HIT",
            },
        )

    # 2. Filesystem lookup
    path = _bucket_path(camera, bucket_ts)
    if not path.exists():
        # Try adjacent buckets (handles rounding edge cases)
        for delta in [-interval, interval]:
            alt_ts = bucket_ts + delta
            alt_path = _bucket_path(camera, alt_ts)
            if alt_path.exists():
                path = alt_path
                bucket_ts = alt_ts
                break
        else:
            # No adjacent bucket either — fall back to DB nearest-neighbor
            return await _fallback_db_lookup(camera, timestamp)

    # 3. Read, cache, return
    try:
        data = path.read_bytes()
    except OSError:
        raise HTTPException(status_code=404, detail="Preview file read error")

    _cache.put(camera, bucket_ts, data)

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
            "X-Preview-Timestamp": f"{bucket_ts:.2f}",
            "X-Cache": "MISS",
        },
    )


async def _fallback_db_lookup(camera: str, timestamp: float):
    """Last resort: DB nearest-neighbor lookup.

    Only used when bucket math fails (e.g. segments with non-standard
    duration, or previews generated with a different interval).
    If this fires often, something is wrong with preview generation.
    """
    log.debug("Bucket miss for %s@%.2f — falling back to DB", camera, timestamp)

    async with get_db() as db:
        row = await db.execute_fetchall(
            """SELECT image_path, ts
               FROM previews
               WHERE camera = ?
               ORDER BY ABS(ts - ?)
               LIMIT 1""",
            (camera, timestamp),
        )

        if not row:
            raise HTTPException(status_code=404, detail="No preview frames for camera")

        image_path = settings.preview_output_path / row[0][0]
        if not image_path.exists():
            raise HTTPException(status_code=404, detail="Preview file missing")

        # Cache this for future bucket hits
        data = image_path.read_bytes()
        actual_ts = row[0][1]
        _cache.put(camera, actual_ts, data)

        return Response(
            content=data,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Preview-Timestamp": f"{actual_ts:.2f}",
                "X-Cache": "FALLBACK",
            },
        )


@router.get("/preview-strip/{camera}", response_model=PreviewStrip)
async def get_preview_strip(
    camera: str,
    start: float = Query(..., description="Start timestamp"),
    end: float = Query(..., description="End timestamp"),
    max_frames: int = Query(200, description="Maximum frames to return", le=500),
):
    """Get a batch of preview frame URLs for a time range.

    Cold path — called once when the timeline loads or the range changes.
    The frontend uses this to know which timestamps have previews and
    preloads them via the /preview endpoint.

    Returns URLs (not images) — the frontend fetches frames individually
    so the LRU cache stays warm.
    """
    async with get_db() as db:
        rows = await db.execute_fetchall(
            """SELECT ts, image_path
               FROM previews
               WHERE camera = ? AND ts >= ? AND ts <= ?
               ORDER BY ts
               LIMIT ?""",
            (camera, start, end, max_frames),
        )

        if not rows:
            return PreviewStrip(
                camera=camera,
                start_ts=start,
                end_ts=end,
                interval=0,
                frames=[],
            )

        frames = [
            PreviewFrame(
                ts=r[0],
                url=f"/api/preview/{camera}/{r[0]}",
            )
            for r in rows
        ]

        interval = settings.preview_interval_sec
        if len(frames) > 1:
            interval = (frames[-1].ts - frames[0].ts) / (len(frames) - 1)

        return PreviewStrip(
            camera=camera,
            start_ts=start,
            end_ts=end,
            interval=interval,
            frames=frames,
        )


@router.get("/segment/{segment_id}/stream")
async def stream_segment(segment_id: int):
    """Stream an MP4 segment for playback.

    Cold path — only called when user commits to a playback position.
    Supports browser range requests for seeking within the segment.
    """
    async with get_db() as db:
        row = await db.execute_fetchall(
            "SELECT path FROM segments WHERE id = ?", (segment_id,)
        )

        if not row:
            raise HTTPException(status_code=404, detail="Segment not found")

        file_path = settings.frigate_recordings_path / row[0][0]
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Segment file missing")

        return FileResponse(
            file_path,
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=3600",
            },
        )


@router.get("/preview/stats")
async def preview_cache_stats():
    """Diagnostic: preview cache hit rate and size."""
    return {
        "cache_size": _cache.size,
        "max_size": _cache._max,
        "hits": _cache.hits,
        "misses": _cache.misses,
        "hit_rate_pct": round(_cache.hit_rate, 1),
    }
