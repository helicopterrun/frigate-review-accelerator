"""Preview API — serves preview frames for timeline scrubbing.

This is the HOT PATH. Every pixel of mouse movement during a scrub
fires a request here. Performance budget: <50ms end-to-end.

v2 changes:
  - Bucket-based O(1) lookup: no DB query per scrub event
    ts → quantize to interval → build filesystem path directly
  - LRU memory cache: last N images held in RAM as bytes
    eliminates disk I/O for recent scrub positions
  - DB is only used for the /preview-strip batch endpoint (cold path)

v3 changes:
  - POST /api/preview/request: on-demand generation hint
    Frontend calls this when the user opens a camera or changes range.
    The worker drains the queue next cycle, prioritizing this viewport.

Phase 3 changes:
  - _fallback_db_lookup removed; miss now enqueues via PreviewScheduler +
    checks for a Frigate event snapshot before returning 404
  - _quantize_ts / _bucket_path now delegate to TimeIndex singleton

The key insight: preview filenames ARE the timestamp (e.g. 1700000002.00.jpg).
So lookup is just math + path construction. No index needed.
"""

import asyncio
import logging
from collections import OrderedDict

import httpx
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import FileResponse, Response

from app.config import settings
from app.models.database import get_db
from app.models.schemas import CameraPreviewStatus, PreviewFrame, PreviewStrip
from app.services.worker import enqueue_preview_request
from app.services.hls import _build_hls_url, _resolve_hls_url
from app.services.time_index import get_time_index

router = APIRouter(prefix="/api", tags=["preview"])
log = logging.getLogger(__name__)

# Strong references to active on-demand tasks — prevents GC before completion
_active_demand_tasks: set[asyncio.Task] = set()

# Limit concurrent on-demand preview generation tasks to avoid overwhelming ffmpeg.
# At most 3 tasks run concurrently; additional requests queue behind the semaphore.
_demand_semaphore = asyncio.Semaphore(3)


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
# Bucket math — delegates to TimeIndex singleton
# ---------------------------------------------------------------------------
def _quantize_ts(ts: float, interval: float) -> float:
    """Snap a timestamp to the nearest preview bucket.

    Keeps the existing signature for callers; delegates to TimeIndex so there
    is a single source of truth for bucket arithmetic.  When interval matches
    settings.preview_interval_sec the module singleton is reused; otherwise a
    lightweight TimeIndex is constructed for the given interval.

    >>> _quantize_ts(1700000003.7, 2.0)
    1700000004.0
    """
    idx = get_time_index()
    if interval == idx._interval:
        return idx.bucket_ts(ts)
    # Different interval requested (e.g. unit tests) — use a temporary index
    from app.services.time_index import TimeIndex
    return TimeIndex(interval=interval).bucket_ts(ts)


def _bucket_path(camera: str, bucket_ts: float):
    """Build the filesystem path for a bucketed preview frame.

    Keeps the existing signature for callers; delegates to TimeIndex singleton.
    Structure: {preview_root}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
    """
    return get_time_index().bucket_path(camera, bucket_ts)


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
      5. On miss: check Frigate event snapshot (Phase 7), enqueue for generation

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
            # No adjacent bucket found — Phase 7: try Frigate event snapshot
            snapshot_data = await _try_frigate_event_snapshot(camera, timestamp)
            if snapshot_data:
                _cache.put(camera, bucket_ts, snapshot_data)
                return Response(
                    content=snapshot_data,
                    media_type="image/jpeg",
                    headers={
                        "Cache-Control": "public, max-age=86400",
                        "X-Preview-Timestamp": f"{bucket_ts:.2f}",
                        "X-Cache": "FRIGATE-SNAPSHOT",
                    },
                )

            # Enqueue this bucket for generation so the next request succeeds
            enqueue_preview_request(camera, bucket_ts, bucket_ts + interval)
            raise HTTPException(
                status_code=404,
                detail="Preview not yet generated — enqueued",
            )

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


async def _try_frigate_event_snapshot(camera: str, timestamp: float) -> bytes | None:
    """Serve the best Frigate event snapshot overlapping this timestamp.

    Selection: highest confidence score; ties broken by temporal proximity.
    If a snapshot is returned, the caller MUST NOT enqueue a generation job —
    Frigate already has the best available frame.
    """
    try:
        async with get_db() as db:
            rows = await db.execute_fetchall(
                """SELECT id, score
                   FROM events
                   WHERE camera = ?
                     AND start_ts <= ?
                     AND (end_ts IS NULL OR end_ts >= ?)
                     AND has_snapshot = 1
                   ORDER BY score DESC, ABS(start_ts - ?) ASC
                   LIMIT 1""",
                (camera, timestamp + 5.0, timestamp - 5.0, timestamp),
            )
        if not rows:
            return None
        event_id, score = rows[0]
        # Verify this URL shape against installed Frigate version
        # and existing working code before changing the path.
        url = f"{settings.frigate_api_url}/api/events/{event_id}/snapshot.jpg"
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
            if r.status_code == 200:
                log.debug(
                    "Phase 7: snapshot event=%s score=%.2f ts=%.0f",
                    event_id, score or 0.0, timestamp,
                )
                return r.content
    except Exception:
        pass
    return None


@router.post("/preview/request")
async def request_previews(
    camera: str = Query(..., description="Camera name"),
    start: float = Query(..., description="Viewport start timestamp (Unix)"),
    end: float = Query(..., description="Viewport end timestamp (Unix)"),
):
    """On-demand hint: prioritize preview generation for this time window.

    Call this when:
      - User selects a camera
      - User changes the time range
      - User scrubs into a region with no previews

    Non-blocking — returns immediately. The background worker drains the
    queue at the start of its next cycle (within scan_interval_sec seconds).

    This is the mechanism that makes the system feel responsive on first use:
    instead of waiting for the recency crawler to reach the right segments,
    the frontend signals exactly which window it needs right now.
    """
    from app.services.preview_generator import process_pending_async
    from app.services.preview_scheduler import get_scheduler

    enqueue_preview_request(camera, start, end)
    get_scheduler().enqueue_viewport(camera, start, end)

    async def _run():
        async with _demand_semaphore:
            try:
                await process_pending_async(limit=30, min_start_ts=start)
            except Exception:
                pass

    task = asyncio.create_task(_run())
    _active_demand_tasks.add(task)
    task.add_done_callback(_active_demand_tasks.discard)

    log.info(
        "On-demand preview request: camera=%s start=%.0f end=%.0f",
        camera, start, end,
    )
    return {"queued": True, "camera": camera, "start": start, "end": end}


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
# MP4 fallback — only used when Frigate VOD is unreachable (hls_url=None).
# Preserve this endpoint. Do not delete it.
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


@router.get("/segment/{segment_id}/info")
async def segment_info(segment_id: int):
    """Get segment metadata and playback URLs by segment ID.

    Used by SplitView.handleSegmentAdvance to resolve the next segment's
    start_ts so it can call /api/playback with an accurate timestamp.
    """
    async with get_db() as db:
        rows = await db.execute_fetchall(
            "SELECT id, camera, start_ts, end_ts, duration FROM segments WHERE id = ?",
            (segment_id,),
        )
        if not rows:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Segment not found")

        seg = rows[0]
        seg_id, camera, start_ts, end_ts, duration = seg

        next_rows = await db.execute_fetchall(
            """SELECT id FROM segments
               WHERE camera = ? AND start_ts > ?
               ORDER BY start_ts
               LIMIT 1""",
            (camera, end_ts - 0.5),
        )
        next_id = next_rows[0][0] if next_rows else None

    hls_url = await _resolve_hls_url(camera, start_ts, start_ts)

    return {
        "id": seg_id,
        "camera": camera,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "duration": duration,
        "stream_url": f"/api/segment/{seg_id}/stream",
        "hls_url": hls_url,
        "next_segment_id": next_id,
    }


@router.get("/preview/progress", response_model=list[CameraPreviewStatus])
async def preview_progress():
    """Per-camera breakdown of preview generation progress.

    Returns counts of done/pending-recent/pending-historical segments per camera.
    Suitable for polling in AdminPanel status tab (call every 10-30s, not hot path).
    """
    import time as _time
    recency_cutoff = _time.time() - settings.preview_recency_hours * 3600

    async with get_db() as db:
        # Total and done per camera
        seg_rows = await db.execute_fetchall(
            """SELECT camera,
                      COUNT(*) as total,
                      SUM(CASE WHEN previews_generated = 1 THEN 1 ELSE 0 END) as done,
                      SUM(CASE WHEN previews_generated = 0 AND start_ts >= ? THEN 1 ELSE 0 END) as pending_recent,
                      SUM(CASE WHEN previews_generated = 0 AND start_ts < ? THEN 1 ELSE 0 END) as pending_hist
               FROM segments
               GROUP BY camera
               ORDER BY camera""",
            (recency_cutoff, recency_cutoff),
        )

    results = []
    for r in seg_rows:
        camera, total, done, p_recent, p_hist = r[0], r[1], r[2], r[3], r[4]
        recent_total = (done or 0) + (p_recent or 0)
        pct = ((done or 0) / recent_total * 100) if recent_total > 0 else 100.0
        results.append(CameraPreviewStatus(
            camera=camera,
            total_segments=total or 0,
            previews_done=done or 0,
            pending_recent=p_recent or 0,
            pending_historical=p_hist or 0,
            pct_recent_complete=round(min(pct, 100.0), 1),
        ))
    return results


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
