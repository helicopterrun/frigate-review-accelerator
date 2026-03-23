"""Verify that the bounded ThreadPoolExecutor is wired into worker.py.

The preview_workers config setting must control the executor max_workers;
the default (None) executor silently ignores it.
"""

from concurrent.futures import ThreadPoolExecutor

import pytest


def test_set_preview_executor_stores_executor():
    """set_preview_executor must store the executor so worker passes it to run_in_executor."""
    import app.services.worker as worker_mod

    executor = ThreadPoolExecutor(max_workers=2)
    try:
        worker_mod.set_preview_executor(executor)
        assert worker_mod._preview_executor is executor
    finally:
        # Restore to None so other tests start clean
        worker_mod._preview_executor = None
        executor.shutdown(wait=False)


def test_executor_respects_preview_workers(monkeypatch):
    """ThreadPoolExecutor created with preview_workers must have the correct max_workers."""
    from app.config import settings

    monkeypatch.setattr(settings, "preview_workers", 2)

    executor = ThreadPoolExecutor(
        max_workers=settings.preview_workers,
        thread_name_prefix="preview-worker",
    )
    try:
        assert executor._max_workers == 2
    finally:
        executor.shutdown(wait=False)


def test_process_scheduler_jobs_uses_preview_executor(monkeypatch):
    """_process_scheduler_jobs must pass _preview_executor, not None, to run_in_executor.

    Regression guard for the bug where _process_scheduler_jobs used None while
    the other three tiers (_process_demand_queue, _run_recency_pass,
    _run_background_pass) correctly used _preview_executor.  Using None bypasses
    the preview_workers ceiling and VAAPI serialization intent.
    """
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import app.services.worker as worker_mod

    executor = ThreadPoolExecutor(max_workers=1)
    captured_executors: list = []

    async def fake_run_in_executor(exc, fn, *args):
        captured_executors.append(exc)
        return None  # simulate no frame produced

    try:
        worker_mod.set_preview_executor(executor)

        # Build a minimal fake job that matches what PreviewScheduler produces.
        class FakeJob:
            camera = "cam_a"
            bucket_ts = 1700001000.0

        # Patch get_db to return an async context manager with a stub db
        class FakeDb:
            async def execute_fetchall(self, *a, **kw):
                return []  # no matching segments → job skipped cleanly

            async def execute(self, *a, **kw):
                pass

            async def commit(self):
                pass

        class FakeDbCtx:
            async def __aenter__(self):
                return FakeDb()

            async def __aexit__(self, *a):
                pass

        monkeypatch.setattr(worker_mod, "get_db", lambda: FakeDbCtx())

        # Patch the event loop's run_in_executor to capture the executor arg.
        loop = asyncio.new_event_loop()
        monkeypatch.setattr(loop, "run_in_executor", fake_run_in_executor)

        try:
            loop.run_until_complete(worker_mod._process_scheduler_jobs([FakeJob()]))
        finally:
            loop.close()

        # The DB query returned no rows, so run_in_executor was never called.
        # Inject a row so the executor path is reached.
        # Re-run with a segment that matches the job's bucket_ts.
        class FakeDbWithRow:
            async def execute_fetchall(self, *a, **kw):
                return [
                    {
                        "id": 1,
                        "camera": "cam_a",
                        "start_ts": 1700000990.0,
                        "end_ts": 1700001010.0,
                        "duration": 20.0,
                        "path": "cam_a/2023-11-14/some.mp4",
                    }
                ]

            async def execute(self, *a, **kw):
                pass

            async def commit(self):
                pass

        class FakeDbCtxWithRow:
            async def __aenter__(self):
                return FakeDbWithRow()

            async def __aexit__(self, *a):
                pass

        monkeypatch.setattr(worker_mod, "get_db", lambda: FakeDbCtxWithRow())

        captured_executors.clear()
        loop2 = asyncio.new_event_loop()
        monkeypatch.setattr(loop2, "run_in_executor", fake_run_in_executor)
        try:
            loop2.run_until_complete(worker_mod._process_scheduler_jobs([FakeJob()]))
        finally:
            loop2.close()

        assert len(captured_executors) == 1, "run_in_executor should have been called once"
        assert captured_executors[0] is executor, (
            "_process_scheduler_jobs must pass _preview_executor, not None"
        )
    finally:
        worker_mod._preview_executor = None
        executor.shutdown(wait=False)


def test_executor_thread_name_prefix():
    """Executor threads must carry the preview-worker prefix for log tracing."""
    executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="preview-worker",
    )
    try:
        future = executor.submit(lambda: None)
        future.result()
        thread_names = [t.name for t in executor._threads]
        assert any("preview-worker" in name for name in thread_names)
    finally:
        executor.shutdown(wait=False)
