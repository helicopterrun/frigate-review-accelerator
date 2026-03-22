"""Verify concurrency-control primitives for preview generation.

_demand_semaphore was removed from preview.py when the on-demand path was
refactored to use timestamp-based queuing in worker.py.  Concurrency is now
controlled by the VAAPI semaphore in preview_generator.py.
"""
import threading
import pytest


def test_vaapi_semaphore_exists():
    """_vaapi_semaphore must exist in preview_generator with the correct type."""
    from app.services.preview_generator import _vaapi_semaphore, _VAAPI_MAX_CONCURRENT
    assert hasattr(_vaapi_semaphore, "acquire")
    assert hasattr(_vaapi_semaphore, "release")
    assert _VAAPI_MAX_CONCURRENT == 1
