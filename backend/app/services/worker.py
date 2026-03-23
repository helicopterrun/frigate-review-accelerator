"""Background worker — periodically scans for new segments and generates previews.

Priority model (three tiers):

  Tier 0 — On-demand
    Individual bucket timestamps explicitly requested by the frontend (user
    opened a camera or changed the time range). Drained every worker cycle
    before anything else.

  Tier 1 — Recency window
    Segments newer than preview_recency_hours (default 48h). One midpoint
    frame per segment, processed every cycle at limit=50.

  Tier 2 — Background crawl
    All remaining pending segments. One midpoint frame per segment. Runs
    every BACKGROUND_INTERVAL cycles at a small batch size (default 20).

Additional jobs:
  - Scheduler jobs: drain PreviewScheduler priority queue (viewport-driven)
  - Event sync: poll Frigate API for new events, runs every cycle after indexing
  - Retention cleanup: delete old previews, runs once daily

Runs as an asyncio task started by the FastAPI lifespan handler.
"""

import asyncio
import logging
import time
from collections import deque

from app.config import settings
from app.models.database import get_db
from app.services.indexer import index_segments_async
from app.services.preview_generator import extract_preview_frame, delete_old_previews_async
from app.services.event_sync import sync_frigate_events
from app.services.preview_scheduler import get_scheduler
from app.services.time_index import get_time_index

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None

# Run background (Tier 2) crawl every N worker cycles.
# At scan_interval_sec=30 and BACKGROUND_INTERVAL=3, that's every ~90 seconds.
BACKGROUND_INTERVAL = 3

# Maximum number of failed extraction attempts before a segment is permanently
# suppressed from the preview queue (previews_generated set to 1 on the
# MAX_RETRIES-th failure). Transient errors (VAAPI spike, I/O blip) recover
# within this many worker cycles. Permanently broken segments (corrupt file,
# missing recording) are suppressed after MAX_RETRIES attempts.
MAX_RETRIES = 3

# On-demand queue: (camera, bucket_ts) pairs pushed by the preview router
# when the frontend signals which timestamps it needs right now.
_demand_queue: deque[tuple[str, float]] = deque(maxlen=50)

# Last time retention cleanup ran (Unix timestamp)
_last_cleanup_ts: float = 0.0
CLEANUP_INTERVAL_SEC = 86400  # once daily


def enqueue_preview_request(camera: str, start_ts: float, end_ts: float) -> None:
    """Queue on-demand preview requests for a specific time window.

    Expands the window into individual bucket timestamps at enqueue time.
    The deque maxlen=50 provides natural backpressure.
    """
    idx = get_time_index()
    for b in idx.buckets_in_range(start_ts, end_ts):
        _demand_queue.append((camera, b))
    log.debug("On-demand preview queued: %s %.0f–%.0f", camera, start_ts, end_ts)


async def _process_demand_queue() -> int:
    """Tier 0: drain the on-demand queue — one frame per bucket timestamp."""
    if not _demand_queue:
        return 0

    total = 0
    loop = asyncio.get_running_loop()

    while _demand_queue:
        camera, bucket_ts = _demand_queue.popleft()

        frame = await loop.run_in_executor(
            None,
            lambda c=camera, b=bucket_ts: extract_preview_frame(
                camera=c,
                ts=b,
                width=settings.preview_width,
                quality=settings.preview_quality,
            ),
        )

        if frame:
            async with get_db() as db:
                await db.execute(
                    """INSERT OR IGNORE INTO previews
                       (camera, ts, segment_id, image_path, width, height)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (frame["camera"], frame["ts"], frame["segment_id"],
                     frame["image_path"], frame["width"], frame["height"]),
                )
                await db.commit()
            total += 1

    return total


async def _run_recency_pass(limit: int = 50) -> int:
    """Tier 1: generate one midpoint preview per recently-added segment."""
    recency_cutoff = time.time() - settings.preview_recency_hours * 3600
    async with get_db() as db:
        rows = await db.execute_fetchall(
            """SELECT id, camera, start_ts, end_ts, duration, path
               FROM segments
               WHERE previews_generated = 0
                 AND start_ts >= ?
               ORDER BY start_ts DESC
               LIMIT ?""",
            (recency_cutoff, limit),
        )

    processed = 0
    loop = asyncio.get_running_loop()
    idx = get_time_index()

    for row in rows:
        segment = {
            "id": row[0], "camera": row[1], "start_ts": row[2],
            "end_ts": row[3], "duration": row[4], "path": row[5],
        }
        midpoint = segment["start_ts"] + segment["duration"] / 2
        bucket_ts = idx.bucket_ts(midpoint)

        frame = await loop.run_in_executor(
            None,
            lambda s=segment, b=bucket_ts: extract_preview_frame(
                camera=s["camera"],
                ts=b,
                width=settings.preview_width,
                quality=settings.preview_quality,
                segment=s,
            ),
        )

        async with get_db() as db:
            if frame:
                await db.execute(
                    """INSERT OR IGNORE INTO previews
                       (camera, ts, segment_id, image_path, width, height)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (frame["camera"], frame["ts"], frame["segment_id"],
                     frame["image_path"], frame["width"], frame["height"]),
                )
                await db.execute(
                    "UPDATE segments SET previews_generated = 1 WHERE id = ?",
                    (segment["id"],),
                )
            else:
                # Increment retry_count. On the MAX_RETRIES-th failure set
                # previews_generated=1 to remove the segment from the queue so
                # it does not consume worker budget indefinitely. The CASE uses
                # the pre-update value of retry_count (SQLite evaluates SET
                # expressions against the old row).
                await db.execute(
                    """UPDATE segments
                       SET retry_count = retry_count + 1,
                           previews_generated = CASE
                               WHEN retry_count + 1 >= ? THEN 1
                               ELSE 0
                           END
                       WHERE id = ?""",
                    (MAX_RETRIES, segment["id"]),
                )
            await db.commit()
        processed += 1

    return processed


async def _run_background_pass(limit: int = 20) -> int:
    """Tier 2: generate one midpoint preview per any pending segment."""
    async with get_db() as db:
        rows = await db.execute_fetchall(
            """SELECT id, camera, start_ts, end_ts, duration, path
               FROM segments
               WHERE previews_generated = 0
               ORDER BY start_ts DESC
               LIMIT ?""",
            (limit,),
        )

    processed = 0
    loop = asyncio.get_running_loop()
    idx = get_time_index()

    for row in rows:
        segment = {
            "id": row[0], "camera": row[1], "start_ts": row[2],
            "end_ts": row[3], "duration": row[4], "path": row[5],
        }
        midpoint = segment["start_ts"] + segment["duration"] / 2
        bucket_ts = idx.bucket_ts(midpoint)

        frame = await loop.run_in_executor(
            None,
            lambda s=segment, b=bucket_ts: extract_preview_frame(
                camera=s["camera"],
                ts=b,
                width=settings.preview_width,
                quality=settings.preview_quality,
                segment=s,
            ),
        )

        async with get_db() as db:
            if frame:
                await db.execute(
                    """INSERT OR IGNORE INTO previews
                       (camera, ts, segment_id, image_path, width, height)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (frame["camera"], frame["ts"], frame["segment_id"],
                     frame["image_path"], frame["width"], frame["height"]),
                )
                await db.execute(
                    "UPDATE segments SET previews_generated = 1 WHERE id = ?",
                    (segment["id"],),
                )
            else:
                await db.execute(
                    """UPDATE segments
                       SET retry_count = retry_count + 1,
                           previews_generated = CASE
                               WHEN retry_count + 1 >= ? THEN 1
                               ELSE 0
                           END
                       WHERE id = ?""",
                    (MAX_RETRIES, segment["id"]),
                )
            await db.commit()
        processed += 1

    return processed


async def _process_scheduler_jobs(jobs: list) -> int:
    """Drain a batch of PreviewScheduler jobs with one DB query per camera group.

    Groups jobs by camera, issues a single bounded DB query per camera group,
    then resolves each job to its segment in memory.  Calls
    extract_preview_frame with the pre-resolved segment so at most one ffmpeg
    invocation fires per job.
    """
    if not jobs:
        return 0

    by_camera: dict[str, list] = {}
    for job in jobs:
        by_camera.setdefault(job.camera, []).append(job)

    processed = 0
    loop = asyncio.get_running_loop()

    async with get_db() as db:
        for camera, cam_jobs in by_camera.items():
            timestamps = [j.bucket_ts for j in cam_jobs]
            min_ts = min(timestamps)
            max_ts = max(timestamps)

            # One query covers all jobs for this camera
            rows = await db.execute_fetchall(
                """SELECT id, camera, start_ts, end_ts, duration, path
                   FROM segments
                   WHERE camera = ?
                     AND start_ts <= ?
                     AND end_ts >= ?
                   ORDER BY start_ts""",
                (camera, max_ts, min_ts),
            )

            for job in cam_jobs:
                seg_row = next(
                    (r for r in rows if r["start_ts"] <= job.bucket_ts <= r["end_ts"]),
                    None,
                )
                if seg_row is None:
                    continue

                segment = {
                    "id": seg_row["id"], "camera": seg_row["camera"],
                    "start_ts": seg_row["start_ts"], "end_ts": seg_row["end_ts"],
                    "duration": seg_row["duration"], "path": seg_row["path"],
                }

                # ffmpeg runs in executor — do not block the event loop
                frame = await loop.run_in_executor(
                    None,
                    lambda s=segment, j=job: extract_preview_frame(
                        camera=s["camera"],
                        ts=j.bucket_ts,
                        width=settings.preview_width,
                        quality=settings.preview_quality,
                        segment=s,
                    ),
                )
                if frame:
                    await db.execute(
                        """INSERT OR IGNORE INTO previews
                           (camera, ts, segment_id, image_path, width, height)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (frame["camera"], frame["ts"], frame["segment_id"],
                         frame["image_path"], frame["width"], frame["height"]),
                    )
                    await db.execute(
                        "UPDATE segments SET previews_generated = 1 WHERE id = ?",
                        (segment["id"],),
                    )
                else:
                    await db.execute(
                        """UPDATE segments
                           SET retry_count = retry_count + 1,
                               previews_generated = CASE
                                   WHEN retry_count + 1 >= ? THEN 1
                                   ELSE 0
                               END
                           WHERE id = ?""",
                        (MAX_RETRIES, segment["id"]),
                    )
                await db.commit()
                processed += 1

    return processed


def get_worker_status() -> dict:
    """Return structured status for /api/admin/status."""
    sched = get_scheduler()
    sched_stats = sched.stats()
    return {
        "demand_queue_depth": len(_demand_queue),
        "last_cleanup_ts": _last_cleanup_ts,
        "scheduler_queue_depth": sched.queue_depth,
        "scheduler_processed_total": sched_stats["processed_total"],
    }


async def _worker_loop():
    """Main worker loop — index → event sync → scheduler → on-demand → recency → background → cleanup."""
    global _last_cleanup_ts

    log.info(
        "Background worker started (scan_interval=%ds, recency=%dh, bg_batch=%d)",
        settings.scan_interval_sec,
        settings.preview_recency_hours,
        settings.preview_background_batch,
    )

    cycle = 0

    while True:
        try:
            # ── Scan for new segments ───────────────────────────────────────
            result = await index_segments_async()
            if result:
                total_new = sum(result.values())
                log.info(
                    "Indexed %d new segments across %d cameras",
                    total_new, len(result),
                )

            # ── Event sync (after indexing, before preview generation) ──────
            try:
                synced = await sync_frigate_events()
                if synced:
                    log.info("Event sync: %d events upserted", synced)
            except Exception:
                log.debug("Event sync skipped (Frigate unreachable)")

            # ── Scheduler jobs: drain priority queue ────────────────────────
            sched = get_scheduler()
            sched_jobs = sched.dequeue_batch(max_items=50)
            if sched_jobs:
                sched_processed = await _process_scheduler_jobs(sched_jobs)
                sched.record_processed(sched_processed)
                if sched_processed:
                    log.info("Scheduler pass: processed %d preview jobs", sched_processed)

            # ── Tier 0: drain on-demand queue ──────────────────────────────
            demand_count = await _process_demand_queue()
            if demand_count:
                log.info(
                    "On-demand pass: generated %d previews",
                    demand_count,
                )

            # ── Tier 1: recency window ──────────────────────────────────────
            recent_count = await _run_recency_pass(limit=50)
            if recent_count:
                log.info(
                    "Recency pass: processed %d segments (last %dh)",
                    recent_count,
                    settings.preview_recency_hours,
                )

            # ── Tier 2: background crawl (every BACKGROUND_INTERVAL cycles) ─
            if settings.preview_background_enabled and cycle % BACKGROUND_INTERVAL == 0:
                bg_count = await _run_background_pass(limit=settings.preview_background_batch)
                if bg_count:
                    log.info(
                        "Background pass: processed %d segments",
                        bg_count,
                    )

            # ── Daily retention cleanup ─────────────────────────────────────
            if settings.preview_retention_days > 0:
                now = time.time()
                if now - _last_cleanup_ts >= CLEANUP_INTERVAL_SEC:
                    deleted = await delete_old_previews_async()
                    _last_cleanup_ts = now
                    if deleted:
                        log.info("Retention cleanup: deleted %d old preview records", deleted)

        except asyncio.CancelledError:
            log.info("Background worker cancelled")
            raise
        except Exception:
            log.exception("Background worker error")

        cycle += 1
        await asyncio.sleep(settings.scan_interval_sec)


def start_worker():
    """Start the background worker task."""
    global _worker_task
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_worker_loop())
        log.info("Background worker task created")


async def stop_worker():
    """Stop the background worker task."""
    global _worker_task
    if _worker_task and not _worker_task.done():
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        log.info("Background worker stopped")
    _worker_task = None
