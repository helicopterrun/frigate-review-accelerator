"""Shared fixtures for integration tests."""

import asyncio
import sqlite3
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ---------------------------------------------------------------------------
# Patch settings BEFORE importing the app so the app sees test paths
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def temp_dirs(tmp_path_factory):
    base = tmp_path_factory.mktemp("frigate_test")
    recordings = base / "recordings"
    previews = base / "previews"
    recordings.mkdir()
    previews.mkdir()
    db_path = base / "test.db"
    return {
        "recordings": recordings,
        "previews": previews,
        "db": db_path,
    }


@pytest.fixture()
def in_memory_db():
    """Synchronous in-memory SQLite with the accelerator schema applied."""
    from app.models.database import SCHEMA
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    yield conn
    conn.close()


@pytest.fixture()
def test_app(tmp_path, monkeypatch):
    """FastAPI test app pointing at temp directories."""
    recordings = tmp_path / "recordings"
    previews = tmp_path / "previews"
    recordings.mkdir()
    previews.mkdir()
    db_path = tmp_path / "test.db"

    # Patch settings before the app module is fully evaluated
    from app import config
    monkeypatch.setattr(config.settings, "frigate_recordings_path", recordings)
    monkeypatch.setattr(config.settings, "preview_output_path", previews)
    monkeypatch.setattr(config.settings, "database_path", db_path)

    # Init DB with schema
    from app.models.database import init_db_sync
    init_db_sync()

    from app.main import app
    return app


@pytest_asyncio.fixture()
async def client(test_app):
    """Async test client for the FastAPI app."""
    async with AsyncClient(
        transport=ASGITransport(app=test_app),
        base_url="http://test",
    ) as c:
        yield c
