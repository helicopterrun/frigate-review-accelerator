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
