"""Background worker — periodically scans for new segments and generates previews.

Runs as an asyncio task started by the FastAPI lifespan handler.
"""

import asyncio
import logging

from app.config import settings
from app.services.indexer import index_segments_async
from app.services.preview_generator import process_pending_async

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None


async def _worker_loop():
    """Main worker loop — index then generate previews, repeat."""
    log.info(
        "Background worker started (scan interval: %ds)",
        settings.scan_interval_sec,
    )

    while True:
        try:
            # Step 1: Scan for new segments
            result = await index_segments_async()
            if result:
                total = sum(result.values())
                log.info("Indexed %d new segments across %d cameras", total, len(result))

            # Step 2: Generate previews for pending segments
            processed = await process_pending_async(limit=100)
            if processed:
                log.info("Generated previews for %d segments", processed)

        except asyncio.CancelledError:
            log.info("Background worker cancelled")
            raise
        except Exception:
            log.exception("Background worker error")

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
