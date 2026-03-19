"""Unit tests for the PreviewScheduler."""

import threading
import time
import pytest


@pytest.fixture()
def scheduler(monkeypatch, tmp_path):
    """Fresh PreviewScheduler with a reset singleton."""
    from app import config
    monkeypatch.setattr(config.settings, "preview_output_path", tmp_path)
    monkeypatch.setattr(config.settings, "preview_interval_sec", 2)
    import app.services.time_index as ti_mod
    ti_mod._time_index = None
    import app.services.preview_scheduler as sched_mod
    sched_mod._scheduler = None
    from app.services.preview_scheduler import PreviewScheduler
    return PreviewScheduler()


class TestEnqueue:
    def test_enqueue_returns_true_first_time(self, scheduler):
        assert scheduler.enqueue("cam", 1000.0, 0) is True

    def test_enqueue_dedup_returns_false(self, scheduler):
        scheduler.enqueue("cam", 1000.0, 0)
        assert scheduler.enqueue("cam", 1000.0, 0) is False

    def test_dedup_different_ts(self, scheduler):
        assert scheduler.enqueue("cam", 1000.0, 0) is True
        assert scheduler.enqueue("cam", 1002.0, 0) is True

    def test_dedup_different_camera(self, scheduler):
        assert scheduler.enqueue("cam-a", 1000.0, 0) is True
        assert scheduler.enqueue("cam-b", 1000.0, 0) is True


class TestDequeue:
    def test_dequeue_priority_order(self, scheduler):
        """P0 must come out before P2 before P4 regardless of enqueue order."""
        from app.services.preview_scheduler import Priority
        scheduler.enqueue("cam", 3000.0, Priority.BACKGROUND)
        scheduler.enqueue("cam", 2000.0, Priority.RECENT)
        scheduler.enqueue("cam", 1000.0, Priority.VIEWPORT)
        batch = scheduler.dequeue_batch(max_items=10)
        assert len(batch) == 3
        assert batch[0].priority == Priority.VIEWPORT
        assert batch[1].priority == Priority.RECENT
        assert batch[2].priority == Priority.BACKGROUND

    def test_dequeue_removes_from_dedup_set(self, scheduler):
        """Re-enqueue must succeed after dequeue."""
        scheduler.enqueue("cam", 1000.0, 0)
        scheduler.dequeue_batch(max_items=1)
        # Now the key should be gone from dedup — re-enqueue must succeed
        assert scheduler.enqueue("cam", 1000.0, 0) is True

    def test_dequeue_batch_respects_max_items(self, scheduler):
        for ts in [1000.0, 1002.0, 1004.0, 1006.0, 1008.0]:
            scheduler.enqueue("cam", ts, 0)
        batch = scheduler.dequeue_batch(max_items=3)
        assert len(batch) == 3
        # The remaining 2 items are still in the queue
        remaining = scheduler.dequeue_batch(max_items=10)
        assert len(remaining) == 2

    def test_dequeue_empty_queue_returns_empty(self, scheduler):
        assert scheduler.dequeue_batch() == []


class TestThreadSafety:
    def test_thread_safety_concurrent_enqueue(self, scheduler):
        """10 threads enqueuing the same key — only 1 must succeed."""
        results = []
        lock = threading.Lock()

        def _enqueue():
            ok = scheduler.enqueue("cam", 5000.0, 0)
            with lock:
                results.append(ok)

        threads = [threading.Thread(target=_enqueue) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(True) == 1
        assert results.count(False) == 9


class TestStats:
    def test_stats_has_required_keys(self, scheduler):
        stats = scheduler.stats()
        required = {
            "queue_depth",
            "enqueued_total",
            "processed_total",
            "skipped_dedup",
            "generation_rate_fps",
        }
        assert required.issubset(stats.keys())

    def test_stats_queue_depth_reflects_enqueue(self, scheduler):
        scheduler.enqueue("cam", 1000.0, 0)
        scheduler.enqueue("cam", 1002.0, 0)
        assert scheduler.stats()["queue_depth"] == 2

    def test_stats_enqueued_total(self, scheduler):
        scheduler.enqueue("cam", 1000.0, 0)
        scheduler.enqueue("cam", 1000.0, 0)  # dedup — skipped
        scheduler.enqueue("cam", 1002.0, 0)
        stats = scheduler.stats()
        assert stats["enqueued_total"] == 2
        assert stats["skipped_dedup"] == 1


class TestEnqueueViewport:
    def test_enqueue_viewport_returns_count(self, scheduler):
        """enqueue_viewport should enqueue P0 buckets for the viewport."""
        count = scheduler.enqueue_viewport("cam", 1700000000.0, 1700000010.0)
        assert count >= 1  # at least the buckets in [start, end]

    def test_enqueue_viewport_dedup_idempotent(self, scheduler):
        """Calling twice should enqueue 0 new jobs the second time."""
        scheduler.enqueue_viewport("cam", 1700000000.0, 1700000010.0)
        second = scheduler.enqueue_viewport("cam", 1700000000.0, 1700000010.0)
        assert second == 0
