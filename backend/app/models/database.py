"""SQLite database schema and connection management.

Tables:
  segments     – one row per Frigate recording segment MP4
  previews     – one row per extracted preview thumbnail
  events       – cached Frigate events for overlay
  scan_state   – tracks last scan position per camera
"""

import aiosqlite
import sqlite3
from pathlib import Path
from contextlib import asynccontextmanager

from app.config import settings

SCHEMA = """
-- Recording segments discovered by the indexer
CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    camera      TEXT NOT NULL,
    start_ts    REAL NOT NULL,   -- Unix timestamp (float)
    end_ts      REAL NOT NULL,
    duration    REAL NOT NULL,   -- seconds
    path        TEXT NOT NULL UNIQUE,
    file_size   INTEGER NOT NULL DEFAULT 0,
    indexed_at  REAL NOT NULL,   -- when we discovered this segment
    previews_generated     INTEGER NOT NULL DEFAULT 0,  -- 0=pending, 1=done
    preview_failure_reason TEXT                          -- set on ffmpeg failure, cleared on success
);

CREATE INDEX IF NOT EXISTS idx_segments_camera_time
    ON segments(camera, start_ts, end_ts);

CREATE INDEX IF NOT EXISTS idx_segments_pending_previews
    ON segments(previews_generated) WHERE previews_generated = 0;

-- Preview thumbnails extracted from segments
CREATE TABLE IF NOT EXISTS previews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    camera      TEXT NOT NULL,
    ts          REAL NOT NULL,   -- Unix timestamp this frame represents
    segment_id  INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    image_path  TEXT NOT NULL,   -- relative path under preview_output_path
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_previews_camera_ts
    ON previews(camera, ts);

-- Cached Frigate events (synced periodically)
CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,  -- Frigate event ID
    camera          TEXT NOT NULL,
    start_ts        REAL NOT NULL,
    end_ts          REAL,              -- NULL if event still active
    label           TEXT NOT NULL,
    score           REAL,
    has_clip        INTEGER NOT NULL DEFAULT 0,
    has_snapshot     INTEGER NOT NULL DEFAULT 0,
    synced_at       REAL NOT NULL,
    zones           TEXT NOT NULL DEFAULT '[]'  -- JSON list of zone names entered
);

CREATE INDEX IF NOT EXISTS idx_events_camera_time
    ON events(camera, start_ts);

-- Scan state tracking
CREATE TABLE IF NOT EXISTS scan_state (
    camera              TEXT PRIMARY KEY,
    last_scanned_ts     REAL NOT NULL DEFAULT 0,
    last_file_path      TEXT,
    last_event_sync_ts  REAL
);
"""


def init_db_sync():
    """Synchronous DB init — used at startup and by CLI tools."""
    settings.ensure_dirs()
    conn = sqlite3.connect(str(settings.database_path))
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
    # Idempotent migrations: add columns to existing databases.
    # New databases already have these from the SCHEMA above.
    for migration in [
        "ALTER TABLE events ADD COLUMN zones TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE segments ADD COLUMN preview_failure_reason TEXT",
    ]:
        try:
            conn.execute(migration)
        except sqlite3.OperationalError:
            pass  # column already exists
    conn.commit()
    conn.close()


@asynccontextmanager
async def get_db():
    """Async context manager for database connections."""
    db = await aiosqlite.connect(str(settings.database_path))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA synchronous=NORMAL")
    try:
        yield db
    finally:
        await db.close()
