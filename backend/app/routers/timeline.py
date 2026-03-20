"""Timeline API — serves the complete time model for a camera.

Key changes from v1:
  - Gap detection: explicitly computes periods with no recording
  - Activity density: bucketized event counts for heatmap rendering
  - /api/playback: backend resolves timestamp → segment + offset
    so the frontend never guesses which segment to load

All timestamp parameters are Unix timestamps (float).
"""

import math
from collections import defaultdict

import httpx
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import Response

from app.config import settings
from app.models.database import get_db
from app.services.hls import _build_hls_url, _resolve_hls_url
from app.services.time_index import get_time_index
from app.models.schemas import (
    ActivityBucket,
    CameraInfo,
    DensityBucket,
    DensityResponse,
    EventInfo,
    GapInfo,
    HealthResponse,
    PlaybackTarget,
    ScanResult,
    SegmentInfo,
    TimelineResponse,
)
from app.services.indexer import index_segments_async

router = APIRouter(prefix="/api", tags=["timeline"])

# Minimum gap duration to report (seconds).
# Gaps shorter than this are segment boundary jitter, not real outages.
MIN_GAP_SEC = 2.0



def _compute_gaps(
    segments: list[SegmentInfo],
    range_start: float,
    range_end: float,
) -> list[GapInfo]:
    """Detect gaps between segments within a time range.

    Walk the sorted segment list and emit a GapInfo for every period
    between the end of one segment and the start of the next that
    exceeds MIN_GAP_SEC.  Also emits leading/trailing gaps if the
    range extends beyond recorded coverage.
    """
    gaps: list[GapInfo] = []
    if not segments:
        # Entire range is one big gap
        dur = range_end - range_start
        if dur > MIN_GAP_SEC:
            gaps.append(GapInfo(start_ts=range_start, end_ts=range_end, duration=dur))
        return gaps

    # Leading gap: range_start → first segment
    first_start = segments[0].start_ts
    if first_start - range_start > MIN_GAP_SEC:
        gaps.append(GapInfo(
            start_ts=range_start,
            end_ts=first_start,
            duration=first_start - range_start,
        ))

    # Inter-segment gaps
    for i in range(len(segments) - 1):
        gap_start = segments[i].end_ts
        gap_end = segments[i + 1].start_ts
        dur = gap_end - gap_start
        if dur > MIN_GAP_SEC:
            gaps.append(GapInfo(start_ts=gap_start, end_ts=gap_end, duration=dur))

    # Trailing gap: last segment → range_end
    last_end = segments[-1].end_ts
    if range_end - last_end > MIN_GAP_SEC:
        gaps.append(GapInfo(
            start_ts=last_end,
            end_ts=range_end,
            duration=range_end - last_end,
        ))

    return gaps


def _compute_activity(
    events: list[EventInfo],
    range_start: float,
    range_end: float,
) -> list[ActivityBucket]:
    """Bucketize events into time slots for heatmap rendering.

    Bucket size adapts to the range:
      ≤1h   → 60s buckets   (60 buckets max)
      ≤4h   → 120s buckets
      ≤12h  → 300s buckets
      ≤24h  → 600s buckets
      >24h  → 1800s buckets
    """
    range_dur = range_end - range_start
    if range_dur <= 3600:
        bucket_sec = 60
    elif range_dur <= 14400:
        bucket_sec = 120
    elif range_dur <= 43200:
        bucket_sec = 300
    elif range_dur <= 86400:
        bucket_sec = 600
    else:
        bucket_sec = 1800

    # Initialize all buckets in range (even empty ones — frontend needs them)
    first_bucket = math.floor(range_start / bucket_sec) * bucket_sec
    buckets: dict[float, dict[str, int]] = {}
    t = first_bucket
    while t < range_end:
        buckets[t] = {}
        t += bucket_sec

    # Count events into buckets
    for evt in events:
        b = math.floor(evt.start_ts / bucket_sec) * bucket_sec
        if b in buckets:
            label = evt.label
            buckets[b][label] = buckets[b].get(label, 0) + 1

    return [
        ActivityBucket(
            bucket_ts=ts,
            count=sum(labels.values()),
            labels=labels,
        )
        for ts, labels in sorted(buckets.items())
    ]


@router.get("/cameras", response_model=list[CameraInfo])
async def list_cameras():
    """List all indexed cameras with summary stats.

    Uses two separate indexed queries instead of a LEFT JOIN across
    1.5M+ rows — the join was causing 60s+ response times.
    """
    async with get_db() as db:
        seg_rows = await db.execute_fetchall(
            """SELECT camera, COUNT(*) as segment_count,
                      MIN(start_ts) as earliest_ts,
                      MAX(end_ts) as latest_ts
               FROM segments
               GROUP BY camera
               ORDER BY camera"""
        )
        prev_rows = await db.execute_fetchall(
            """SELECT camera, COUNT(*) as preview_count
               FROM previews
               GROUP BY camera"""
        )

        prev_map = {r[0]: r[1] for r in prev_rows}

        return [
            CameraInfo(
                name=r[0],
                segment_count=r[1],
                preview_count=prev_map.get(r[0], 0),
                earliest_ts=r[2],
                latest_ts=r[3],
            )
            for r in seg_rows
        ]


@router.get("/timeline", response_model=TimelineResponse)
async def get_timeline(
    camera: str = Query(..., description="Camera name"),
    start: float = Query(..., description="Start timestamp (Unix)"),
    end: float = Query(..., description="End timestamp (Unix)"),
):
    # INVARIANT: Timeline endpoints are READ-ONLY.
    # This function must NEVER trigger: preview generation, ffprobe,
    # filesystem scans, or segment iteration.
    # If you are adding writes here — stop and reconsider.
    """Get the complete time model for a camera within a range.

    Returns segments, gaps, events, and activity density.
    The frontend uses this single response to render the full timeline —
    segments as filled bars, gaps as hatched/dark regions, events as
    colored markers, and activity as a heatmap layer.
    """
    async with get_db() as db:
        # Segments overlapping the range
        seg_rows = await db.execute_fetchall(
            """SELECT id, camera, start_ts, end_ts, duration, previews_generated
               FROM segments
               WHERE camera = ? AND end_ts >= ? AND start_ts <= ?
               ORDER BY start_ts""",
            (camera, start, end),
        )

        segments = [
            SegmentInfo(
                id=r[0], camera=r[1], start_ts=r[2], end_ts=r[3],
                duration=r[4], has_previews=bool(r[5]),
            )
            for r in seg_rows
        ]

        # Events overlapping the range
        evt_rows = await db.execute_fetchall(
            """SELECT id, camera, start_ts, end_ts, label, score, has_snapshot
               FROM events
               WHERE camera = ?
                 AND (end_ts IS NULL OR end_ts >= ?)
                 AND start_ts <= ?
               ORDER BY start_ts""",
            (camera, start, end),
        )

        events = [
            EventInfo(
                id=r[0], camera=r[1], start_ts=r[2], end_ts=r[3],
                label=r[4], score=r[5], has_snapshot=bool(r[6]),
            )
            for r in evt_rows
        ]

        # Compute derived data
        gaps = _compute_gaps(segments, start, end)
        activity = _compute_activity(events, start, end)

        # Coverage percentage
        range_duration = end - start
        covered = sum(
            min(s.end_ts, end) - max(s.start_ts, start) for s in segments
        )
        coverage_pct = (covered / range_duration * 100) if range_duration > 0 else 0

        return TimelineResponse(
            camera=camera,
            start_ts=start,
            end_ts=end,
            segments=segments,
            gaps=gaps,
            events=events,
            activity=activity,
            coverage_pct=min(coverage_pct, 100.0),
        )


@router.get("/playback", response_model=PlaybackTarget)
async def get_playback_target(
    camera: str = Query(..., description="Camera name"),
    ts: float = Query(..., description="Desired playback timestamp (Unix)"),
):
    """Resolve a timestamp to a concrete playback target.

    The backend does the segment lookup so the frontend doesn't have to.
    Returns the segment ID, pre-calculated offset, a ready-to-use stream
    URL, and the next segment ID for preloading.

    If the exact timestamp falls in a gap, snaps to the nearest segment
    boundary (preferring the segment that starts after the gap).
    """
    async with get_db() as db:
        # Try exact hit first: segment containing the timestamp
        rows = await db.execute_fetchall(
            """SELECT id, start_ts, end_ts, duration
               FROM segments
               WHERE camera = ? AND start_ts <= ? AND end_ts >= ?
               ORDER BY start_ts
               LIMIT 1""",
            (camera, ts, ts),
        )

        if not rows:
            # Timestamp is in a gap — find nearest segment
            # Check the segment that starts after this ts
            after = await db.execute_fetchall(
                """SELECT id, start_ts, end_ts, duration
                   FROM segments
                   WHERE camera = ? AND start_ts > ?
                   ORDER BY start_ts
                   LIMIT 1""",
                (camera, ts),
            )
            # And the segment that ends before this ts
            before = await db.execute_fetchall(
                """SELECT id, start_ts, end_ts, duration
                   FROM segments
                   WHERE camera = ? AND end_ts < ?
                   ORDER BY end_ts DESC
                   LIMIT 1""",
                (camera, ts),
            )

            # Pick whichever is closer; prefer "after" on tie
            best = None
            if after and before:
                dist_after = after[0][1] - ts
                dist_before = ts - before[0][2]
                best = after[0] if dist_after <= dist_before else before[0]
            elif after:
                best = after[0]
            elif before:
                best = before[0]

            if not best:
                raise HTTPException(
                    status_code=404,
                    detail=f"No segments found for camera '{camera}'"
                )
            rows = [best]

        seg = rows[0]
        seg_id = seg[0]
        seg_start = seg[1]
        seg_end = seg[2]
        offset = max(0.0, ts - seg_start)

        # Find next segment for preloading
        next_rows = await db.execute_fetchall(
            """SELECT id FROM segments
               WHERE camera = ? AND start_ts > ?
               ORDER BY start_ts
               LIMIT 1""",
            (camera, seg_end - 0.5),  # small overlap tolerance
        )
        next_id = next_rows[0][0] if next_rows else None

        # Playback = Frigate VOD only. See CLAUDE.md architectural invariant.
        hls_url = await _resolve_hls_url(camera, ts, seg_start)

        return PlaybackTarget(
            camera=camera,
            requested_ts=ts,
            segment_id=seg_id,
            segment_start_ts=seg_start,
            segment_end_ts=seg_end,
            offset_sec=round(offset, 3),
            stream_url=f"/api/segment/{seg_id}/stream",
            next_segment_id=next_id,
            hls_url=hls_url,
        )


@router.get("/events/{event_id}/snapshot")
async def get_event_snapshot(event_id: str):
    """Proxy Frigate event snapshot to avoid CORS issues on the frontend."""
    url = f"{settings.frigate_api_url}/api/events/{event_id}/snapshot.jpg"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
            if r.status_code == 200:
                return Response(
                    content=r.content,
                    media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"},
                )
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="Snapshot not available")


@router.post("/index/scan", response_model=list[ScanResult])
async def trigger_scan():
    """Manually trigger a segment scan."""
    result = await index_segments_async()
    async with get_db() as db:
        results = []
        for camera, new_count in result.items():
            row = await db.execute_fetchall(
                "SELECT COUNT(*) FROM segments WHERE camera = ?", (camera,)
            )
            results.append(ScanResult(
                camera=camera,
                new_segments=new_count,
                total_segments=row[0][0],
            ))
        return results


@router.get("/timeline/buckets")
async def get_timeline_buckets(
    camera: str = Query(..., description="Camera name"),
    start: float = Query(..., description="Start timestamp (Unix)"),
    end: float = Query(..., description="End timestamp (Unix)"),
    resolution: int | None = Query(None, description="Number of time buckets across the range", ge=1, le=5000),
):
    # INVARIANT: Timeline endpoints are READ-ONLY.
    # This function must NEVER trigger: preview generation, ffprobe,
    # filesystem scans, or segment iteration.
    # If you are adding writes here — stop and reconsider.
    """Get time-indexed bucket coverage for a camera + range.

    Returns one entry per logical bucket, each indicating whether a preview
    exists (checked against DB, not filesystem) and the density of Frigate
    events in that window.

    resolution omitted → auto-selected via TimeIndex.auto_resolution (resolution_source="auto")
    resolution provided → used as-is (resolution_source="explicit")

    Response shape:
    {
      "camera": "...",
      "start_ts": 0.0,
      "end_ts": 0.0,
      "resolution": 60,
      "resolution_source": "auto",
      "bucket_count": 60,
      "buckets": [{"ts": 0.0, "has_preview": true, "event_density": 3}]
    }
    """
    from app.services.time_index import TimeIndex

    # Determine resolution and its source
    range_sec = end - start
    if resolution is None:
        bucket_sec = TimeIndex.auto_resolution(range_sec)
        effective_resolution = max(1, round(range_sec / bucket_sec)) if range_sec > 0 else 1
        resolution_source = "auto"
    else:
        effective_resolution = resolution
        resolution_source = "explicit"

    # Load events and preview timestamps from DB (READ-ONLY — no writes, no fs scans)
    async with get_db() as db:
        evt_rows = await db.execute_fetchall(
            """SELECT id, camera, start_ts, end_ts, label, score, has_snapshot
               FROM events
               WHERE camera = ?
                 AND (end_ts IS NULL OR end_ts >= ?)
                 AND start_ts <= ?
               ORDER BY start_ts""",
            (camera, start, end),
        )
        prev_rows = await db.execute_fetchall(
            "SELECT ts FROM previews WHERE camera = ? AND ts >= ? AND ts <= ?",
            (camera, start, end),
        )

    events = [
        EventInfo(
            id=r[0], camera=r[1], start_ts=r[2], end_ts=r[3],
            label=r[4], score=r[5], has_snapshot=bool(r[6]),
        )
        for r in evt_rows
    ]
    preview_ts_set = {r[0] for r in prev_rows}

    buckets = get_time_index().timeline_buckets(
        start, end, camera, events, effective_resolution, preview_ts_set=preview_ts_set
    )

    return {
        "camera": camera,
        "start_ts": start,
        "end_ts": end,
        "resolution": effective_resolution,
        "resolution_source": resolution_source,
        "bucket_count": len(buckets),
        "buckets": buckets,
    }


@router.get("/timeline/density", response_model=DensityResponse)
async def get_timeline_density(
    camera: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    bucket_sec: int | None = Query(None, ge=1, le=3600),
):
    # INVARIANT: Timeline endpoints are READ-ONLY.
    # This function must NEVER trigger: preview generation, ffprobe,
    # filesystem scans, or segment iteration.
    # If you are adding writes here — stop and reconsider.
    """Lightweight per-bucket tracked object counts for canvas density rendering.

    Use this during panning instead of the full /api/timeline endpoint.
    Returns only density data — no segments, gaps, or preview info.

    bucket_sec omitted → auto-selected via TimeIndex.auto_resolution(end - start).
    Overlapping events are counted in every bucket they span (unlike activity
    in /api/timeline which counts only at start_ts).
    """
    from app.services.time_index import TimeIndex, get_time_index

    if bucket_sec is None:
        bucket_sec = TimeIndex.auto_resolution(end - start)

    async with get_db() as db:
        rows = await db.execute_fetchall(
            """SELECT start_ts, end_ts, label, score, zones
               FROM events
               WHERE camera = ?
                 AND (end_ts IS NULL OR end_ts >= ?)
                 AND start_ts <= ?
               ORDER BY start_ts""",
            (camera, start, end),
        )

    important_labels = set(settings.important_labels)
    buckets = get_time_index().compute_density_buckets(
        rows, start, end, bucket_sec, important_labels=important_labels
    )

    return DensityResponse(
        camera=camera,
        start_ts=start,
        end_ts=end,
        bucket_sec=bucket_sec,
        buckets=[DensityBucket(**b) for b in buckets],
    )


@router.get("/debug/stats")
async def debug_stats():
    """Observability endpoint: preview cache stats + scheduler queue stats.

    Pulls preview_hits/misses/cache_size from the ImageCache in preview.py
    and queue stats from the PreviewScheduler singleton.
    """
    from app.routers.preview import _cache
    from app.services.preview_scheduler import get_scheduler

    sched_stats = get_scheduler().stats()
    total = _cache.hits + _cache.misses
    hit_rate = (_cache.hits / total * 100) if total > 0 else 0.0

    return {
        "preview_hits": _cache.hits,
        "preview_misses": _cache.misses,
        "cache_hit_rate_pct": round(hit_rate, 1),
        "cache_size": _cache.size,
        "cache_max_size": _cache._max,
        "queue_depth": sched_stats["queue_depth"],
        "generation_rate_fps": sched_stats["generation_rate_fps"],
        "enqueued_total": sched_stats["enqueued_total"],
        "processed_total": sched_stats["processed_total"],
        "skipped_dedup": sched_stats["skipped_dedup"],
    }


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check with system stats."""
    async with get_db() as db:
        cam_count = (await db.execute_fetchall(
            "SELECT COUNT(DISTINCT camera) FROM segments"
        ))[0][0]
        seg_count = (await db.execute_fetchall(
            "SELECT COUNT(*) FROM segments"
        ))[0][0]
        prev_count = (await db.execute_fetchall(
            "SELECT COUNT(*) FROM previews"
        ))[0][0]
        # Segments with no previews yet — "pending", not "generating".
        # The worker processes these in priority order (recency-first);
        # they are NOT all being processed simultaneously.
        pending = (await db.execute_fetchall(
            "SELECT COUNT(*) FROM segments WHERE previews_generated = 0"
        ))[0][0]

    # Check Frigate reachability
    frigate_ok = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{settings.frigate_api_url}/api/version")
            frigate_ok = r.status_code == 200
    except Exception:
        pass

    return HealthResponse(
        status="ok",
        cameras=cam_count,
        total_segments=seg_count,
        total_previews=prev_count,
        pending_previews=pending,
        frigate_reachable=frigate_ok,
    )
