"""Shared fixtures for integration tests."""

import asyncio
import json
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport


# ---------------------------------------------------------------------------
# DB helpers — plain functions shared across all integration test modules.
# Not fixtures: import explicitly where needed.
# ---------------------------------------------------------------------------

def _insert_segment(db_path, camera, start_ts, end_ts, previews_generated=1):
    """Insert a test segment row directly into the DB."""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """INSERT INTO segments
               (camera, start_ts, end_ts, duration, path, file_size, indexed_at, previews_generated)
               VALUES (?, ?, ?, ?, ?, 1024, ?, ?)""",
        (camera, start_ts, end_ts, end_ts - start_ts,
         f"{camera}/{start_ts:.0f}.mp4", time.time(), previews_generated),
    )
    conn.commit()
    conn.close()


def _insert_event(db_path, camera, start_ts, end_ts=None, label="person", zones=None):
    """Insert a test event row directly into the DB."""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """INSERT INTO events
               (id, camera, start_ts, end_ts, label, score, has_clip, has_snapshot, synced_at, zones)
               VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)""",
        (f"{camera}-{start_ts}", camera, start_ts, end_ts, label, 0.9, time.time(),
         json.dumps(zones or [])),
    )
    conn.commit()
    conn.close()

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


# function-scoped: each test gets a fresh DB.
# Camera names in tests must be unique per test function to prevent
# phantom row bleed if scope is ever elevated. See F-15 in code review.
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
