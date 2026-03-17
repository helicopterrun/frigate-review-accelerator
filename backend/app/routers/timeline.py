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

from fastapi import APIRouter, Query, HTTPException

from app.models.database import get_db
from app.models.schemas import (
    ActivityBucket,
    CameraInfo,
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
    """List all indexed cameras with summary stats."""
    async with get_db() as db:
        rows = await db.execute_fetchall(
            """SELECT
                 s.camera,
                 COUNT(DISTINCT s.id) as segment_count,
                 COUNT(DISTINCT p.id) as preview_count,
                 MIN(s.start_ts) as earliest_ts,
                 MAX(s.end_ts) as latest_ts
               FROM segments s
               LEFT JOIN previews p ON p.camera = s.camera
               GROUP BY s.camera
               ORDER BY s.camera"""
        )
        return [
            CameraInfo(
                name=r[0],
                segment_count=r[1],
                preview_count=r[2],
                earliest_ts=r[3],
                latest_ts=r[4],
            )
            for r in rows
        ]


@router.get("/timeline", response_model=TimelineResponse)
async def get_timeline(
    camera: str = Query(..., description="Camera name"),
    start: float = Query(..., description="Start timestamp (Unix)"),
    end: float = Query(..., description="End timestamp (Unix)"),
):
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
            """SELECT id, camera, start_ts, end_ts, label, score
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
                label=r[4], score=r[5],
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

        return PlaybackTarget(
            camera=camera,
            requested_ts=ts,
            segment_id=seg_id,
            segment_start_ts=seg_start,
            segment_end_ts=seg_end,
            offset_sec=round(offset, 3),
            stream_url=f"/api/segment/{seg_id}/stream",
            next_segment_id=next_id,
        )


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


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check with system stats."""
    import httpx
    from app.config import settings

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
