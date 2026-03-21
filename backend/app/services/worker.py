"""Background worker — periodically scans for new segments and generates previews.

Priority model (three tiers):

  Tier 0 — On-demand
    Segments explicitly requested by the frontend (user opened a camera or
    changed the time range). Drained every worker cycle before anything else.

  Tier 1 — Recency window
    Segments newer than preview_recency_hours (default 48h). Processed every
    cycle at limit=100.

  Tier 2 — Background crawl
    All remaining pending segments. Runs every BACKGROUND_INTERVAL cycles at
    a small batch size (default 20).

Additional jobs:
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
from app.services.preview_generator import process_pending_async, delete_old_previews_async, generate_previews_for_segment
from app.services.event_sync import sync_frigate_events
from app.services.preview_scheduler import get_scheduler

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None

# Run background (Tier 2) crawl every N worker cycles.
# At scan_interval_sec=30 and BACKGROUND_INTERVAL=3, that's every ~90 seconds.
BACKGROUND_INTERVAL = 3

# On-demand queue: (camera, start_ts, end_ts) tuples pushed by the preview
# router when the frontend signals which time window it needs right now.
_demand_queue: deque[tuple[str, float, float]] = deque(maxlen=50)

# Last time retention cleanup ran (Unix timestamp)
_last_cleanup_ts: float = 0.0
CLEANUP_INTERVAL_SEC = 86400  # once daily


def enqueue_preview_request(camera: str, start_ts: float, end_ts: float) -> None:
    """Queue an on-demand preview request for a specific time window."""
    _demand_queue.append((camera, start_ts, end_ts))
    log.debug("On-demand preview queued: %s %.0f–%.0f", camera, start_ts, end_ts)


async def _process_demand_queue() -> int:
    """Tier 0: drain the on-demand queue."""
    if not _demand_queue:
        return 0

    total = 0
    while _demand_queue:
        camera, start_ts, end_ts = _demand_queue.popleft()
        count = await process_pending_async(
            limit=30,
            min_start_ts=start_ts,
        )
        total += count
        log.debug(
            "On-demand processed %d segments for %s %.0f–%.0f",
            count, camera, start_ts, end_ts,
        )

    return total


async def _process_scheduler_jobs(jobs: list) -> int:
    """Drain a batch of PreviewScheduler jobs with one DB query per camera group.

    Groups jobs by camera, issues a single bounded DB query per camera group,
    then resolves each job to its segment in memory.  Calls
    generate_previews_for_segment with target_bucket_ts so at most one ffmpeg
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
                segment = next(
                    (r for r in rows if r["start_ts"] <= job.bucket_ts <= r["end_ts"]),
                    None,
                )
                if segment is None:
                    continue

                # ffmpeg runs in executor — do not block the event loop
                # target_bucket_ts ensures exactly one ffmpeg call per job
                frames = await loop.run_in_executor(
                    None,
                    lambda s=segment, j=job: generate_previews_for_segment(
                        segment_path=s["path"],
                        camera=s["camera"],
                        start_ts=s["start_ts"],
                        end_ts=s["end_ts"],
                        duration=s["duration"],
                        segment_id=s["id"],
                        target_bucket_ts=j.bucket_ts,
                    ),
                )
                if frames:
                    await db.executemany(
                        """INSERT OR IGNORE INTO previews
                           (camera, ts, segment_id, image_path, width, height)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        [(f["camera"], f["ts"], f["segment_id"],
                          f["image_path"], f["width"], f["height"])
                         for f in frames],
                    )
                await db.execute(
                    "UPDATE segments SET previews_generated = 1 WHERE id = ?",
                    (segment["id"],),
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
    """Main worker loop — index → event sync → on-demand → recency → background → cleanup."""
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
                    "On-demand pass: generated previews for %d segments",
                    demand_count,
                )

            # ── Tier 1: recency window ──────────────────────────────────────
            recency_cutoff = time.time() - settings.preview_recency_hours * 3600
            recent_count = await process_pending_async(
                limit=50,
                min_start_ts=recency_cutoff,
            )
            if recent_count:
                log.info(
                    "Recency pass: generated previews for %d segments (last %dh)",
                    recent_count,
                    settings.preview_recency_hours,
                )

            # ── Tier 2: background crawl (every BACKGROUND_INTERVAL cycles) ─
            if settings.preview_background_enabled and cycle % BACKGROUND_INTERVAL == 0:
                bg_count = await process_pending_async(
                    limit=settings.preview_background_batch,
                    min_start_ts=None,
                )
                if bg_count:
                    log.info(
                        "Background pass: generated previews for %d segments",
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
