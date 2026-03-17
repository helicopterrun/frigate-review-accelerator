"""Background worker — periodically scans for new segments and generates previews.

Priority model (three tiers):

  Tier 0 — On-demand
    Segments explicitly requested by the frontend (user opened a camera or
    changed the time range). Drained every worker cycle before anything else.
    Pushed via enqueue_preview_request(); the preview router calls this when
    the frontend POSTs /api/preview/request.

  Tier 1 — Recency window
    Segments newer than preview_recency_hours (default 48h). Processed every
    cycle at limit=100. This is what makes the system feel "instant" after a
    fresh index — recent footage is ready within a few minutes rather than
    waiting behind 1.5M historical segments.

  Tier 2 — Background crawl
    All remaining pending segments. Runs every BACKGROUND_INTERVAL cycles at
    a small batch size (default 20). Ensures historical footage is eventually
    covered without overwhelming CPU/disk.

Runs as an asyncio task started by the FastAPI lifespan handler.
"""

import asyncio
import logging
import time
from collections import deque

from app.config import settings
from app.services.indexer import index_segments_async
from app.services.preview_generator import process_pending_async

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None

# Run background (Tier 2) crawl every N worker cycles.
# At scan_interval_sec=30 and BACKGROUND_INTERVAL=10, that's every ~5 minutes.
BACKGROUND_INTERVAL = 10

# On-demand queue: (camera, start_ts, end_ts) tuples pushed by the preview
# router when the frontend signals which time window it needs right now.
# maxlen bounds memory — oldest entries are dropped if the queue fills up.
_demand_queue: deque[tuple[str, float, float]] = deque(maxlen=50)


def enqueue_preview_request(camera: str, start_ts: float, end_ts: float) -> None:
    """Queue an on-demand preview request for a specific time window.

    Called by POST /api/preview/request. Non-blocking — the worker drains
    this queue at the start of each cycle.
    """
    _demand_queue.append((camera, start_ts, end_ts))
    log.debug("On-demand preview queued: %s %.0f–%.0f", camera, start_ts, end_ts)


async def _process_demand_queue() -> int:
    """Tier 0: drain the on-demand queue.

    Each entry represents a viewport the user is actively looking at, so we
    process with a tight limit per entry to stay responsive. The recency pass
    (Tier 1) handles any overflow for the same time window.
    """
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


async def _worker_loop():
    """Main worker loop — index → on-demand → recency → background."""
    log.info(
        "Background worker started (scan_interval=%ds, recency=%dh, bg_batch=%d)",
        settings.scan_interval_sec,
        settings.preview_recency_hours,
        settings.preview_background_batch,
    )

    cycle = 0

    while True:
        try:
            # ── Tier 0: scan for new segments ──────────────────────────────
            result = await index_segments_async()
            if result:
                total_new = sum(result.values())
                log.info(
                    "Indexed %d new segments across %d cameras",
                    total_new, len(result),
                )

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
                limit=100,
                min_start_ts=recency_cutoff,
            )
            if recent_count:
                log.info(
                    "Recency pass: generated previews for %d segments (last %dh)",
                    recent_count,
                    settings.preview_recency_hours,
                )

            # ── Tier 2: background crawl (runs every BACKGROUND_INTERVAL cycles)
            if settings.preview_background_enabled and cycle % BACKGROUND_INTERVAL == 0:
                bg_count = await process_pending_async(
                    limit=settings.preview_background_batch,
                    min_start_ts=None,  # no filter — picks up oldest pending segments
                )
                if bg_count:
                    log.info(
                        "Background pass: generated previews for %d segments",
                        bg_count,
                    )

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
