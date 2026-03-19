"""PreviewScheduler — priority-based, deduplicated preview generation queue.

Designed for thread-safety: the background worker runs in a ThreadPoolExecutor
while the FastAPI event loop enqueues from async request handlers.  All mutable
state is protected by a threading.Lock.

Priority levels (lower number = higher urgency):
  VIEWPORT      (0)  — buckets visible in the current scrub window
  NEAR_VIEWPORT (1)  — adjacent buckets just outside the viewport
  RECENT        (2)  — within the recency window (set by worker.py)
  EVENT_REGION  (3)  — overlaps a Frigate detection event
  BACKGROUND    (4)  — historical fill

Uses heapq for O(log n) enqueue/dequeue and a set for O(1) dedup.
"""

import heapq
import threading
import time
from enum import IntEnum
from dataclasses import dataclass, field

from app.config import settings
from app.services.time_index import get_time_index


class Priority(IntEnum):
    VIEWPORT = 0
    NEAR_VIEWPORT = 1
    RECENT = 2
    EVENT_REGION = 3
    BACKGROUND = 4


@dataclass(order=True)
class PreviewJob:
    """A single preview-generation job for the scheduler heap."""
    priority: int
    enqueued_at: float
    bucket_ts: float = field(compare=False)
    camera: str = field(compare=False)


class PreviewScheduler:
    """Thread-safe priority queue for preview generation jobs."""

    def __init__(self):
        self._heap: list[PreviewJob] = []
        self._dedup: set[tuple[str, float]] = set()  # (camera, bucket_ts)
        self._lock = threading.Lock()

        # Observability counters
        self._enqueued_total: int = 0
        self._processed_total: int = 0
        self._skipped_dedup: int = 0

        # Generation rate tracking (rolling window)
        self._rate_window: list[float] = []  # timestamps of completed jobs
        self._RATE_WINDOW_SEC = 60.0

    # ------------------------------------------------------------------
    # Enqueue
    # ------------------------------------------------------------------
    def enqueue(self, camera: str, bucket_ts: float, priority: int) -> bool:
        """Enqueue a single bucket for generation.

        Thread-safe.  Returns False if already queued (dedup), True otherwise.
        """
        key = (camera, bucket_ts)
        with self._lock:
            if key in self._dedup:
                self._skipped_dedup += 1
                return False
            job = PreviewJob(
                priority=priority,
                enqueued_at=time.monotonic(),
                bucket_ts=bucket_ts,
                camera=camera,
            )
            heapq.heappush(self._heap, job)
            self._dedup.add(key)
            self._enqueued_total += 1
            return True

    def enqueue_viewport(self, camera: str, start_ts: float, end_ts: float) -> int:
        """Enqueue P0 for all buckets inside viewport, P1 for near-viewport buffer.

        Buffer is 5 * interval on each side of the viewport.
        Returns the count of newly-enqueued jobs.
        """
        idx = get_time_index()
        interval = idx._interval
        buffer = 5 * interval

        new_count = 0
        # P0 — viewport buckets
        for b in idx.buckets_in_range(start_ts, end_ts):
            if self.enqueue(camera, b, Priority.VIEWPORT):
                new_count += 1
        # P1 — near-viewport buffer (left side)
        for b in idx.buckets_in_range(start_ts - buffer, start_ts):
            if self.enqueue(camera, b, Priority.NEAR_VIEWPORT):
                new_count += 1
        # P1 — near-viewport buffer (right side)
        for b in idx.buckets_in_range(end_ts, end_ts + buffer):
            if self.enqueue(camera, b, Priority.NEAR_VIEWPORT):
                new_count += 1
        return new_count

    def enqueue_event_region(self, camera: str, event_start_ts: float, event_end_ts: float) -> int:
        """Enqueue EVENT_REGION priority for all buckets covering an event.

        Returns the count of newly-enqueued jobs.
        """
        idx = get_time_index()
        new_count = 0
        for b in idx.buckets_in_range(event_start_ts, event_end_ts):
            if self.enqueue(camera, b, Priority.EVENT_REGION):
                new_count += 1
        return new_count

    # ------------------------------------------------------------------
    # Dequeue
    # ------------------------------------------------------------------
    def dequeue_batch(self, max_items: int = 50) -> list[PreviewJob]:
        """Pop up to max_items highest-priority jobs.

        Removes each job from the dedup set so it can be re-enqueued later
        (e.g. after a generation failure).
        """
        result: list[PreviewJob] = []
        with self._lock:
            while self._heap and len(result) < max_items:
                job = heapq.heappop(self._heap)
                key = (job.camera, job.bucket_ts)
                self._dedup.discard(key)
                result.append(job)
        return result

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------
    def record_processed(self, count: int = 1):
        """Record that `count` jobs were successfully processed."""
        now = time.monotonic()
        with self._lock:
            self._processed_total += count
            self._rate_window.extend([now] * count)
            # Trim old entries outside the rolling window
            cutoff = now - self._RATE_WINDOW_SEC
            self._rate_window = [t for t in self._rate_window if t >= cutoff]

    def stats(self) -> dict:
        """Return observability snapshot for /api/debug/stats."""
        now = time.monotonic()
        with self._lock:
            cutoff = now - self._RATE_WINDOW_SEC
            recent = [t for t in self._rate_window if t >= cutoff]
            rate = len(recent) / self._RATE_WINDOW_SEC if recent else 0.0
            return {
                "queue_depth": len(self._heap),
                "enqueued_total": self._enqueued_total,
                "processed_total": self._processed_total,
                "skipped_dedup": self._skipped_dedup,
                "generation_rate_fps": round(rate, 3),
            }


# ---------------------------------------------------------------------------
# Module-level singleton + convenience wrapper
# ---------------------------------------------------------------------------
_scheduler: PreviewScheduler | None = None


def get_scheduler() -> PreviewScheduler:
    """Return the module-level PreviewScheduler singleton."""
    global _scheduler
    if _scheduler is None:
        _scheduler = PreviewScheduler()
    return _scheduler


def enqueue_preview(bucket_ts: float, camera: str, priority: int) -> bool:
    """Convenience wrapper: enqueue a single bucket via the module singleton."""
    return get_scheduler().enqueue(camera, bucket_ts, priority)
