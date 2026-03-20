"""Verify the on-demand preview semaphore limits concurrent tasks."""
import asyncio
import pytest


@pytest.mark.asyncio
async def test_demand_semaphore_limits_concurrency():
    """_demand_semaphore should exist and allow at most 3 concurrent tasks."""
    from app.routers.preview import _demand_semaphore
    assert isinstance(_demand_semaphore, asyncio.Semaphore)
    # Internal value reflects the configured limit of 3
    assert _demand_semaphore._value == 3  # noqa: SLF001
