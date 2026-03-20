"""Integration tests — FastAPI endpoints against real in-memory SQLite."""

import sqlite3
import time

import pytest
import pytest_asyncio


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _insert_segment(db_path, camera, start_ts, end_ts, previews_generated=1):
    """Insert a test segment row directly into the DB."""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """INSERT INTO segments (camera, start_ts, end_ts, duration, path, file_size, indexed_at, previews_generated)
           VALUES (?, ?, ?, ?, ?, 1024, ?, ?)""",
        (camera, start_ts, end_ts, end_ts - start_ts,
         f"{camera}/{start_ts:.0f}.mp4", time.time(), previews_generated),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

async def test_health_returns_200(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "total_segments" in data
    assert "pending_previews" in data


# ---------------------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------------------

async def test_cameras_empty_initially(client):
    resp = await client.get("/api/cameras")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_cameras_returns_indexed_cameras(client, test_app, tmp_path, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    _insert_segment(db_path, "front-door", 1700000000.0, 1700000010.0)
    resp = await client.get("/api/cameras")
    assert resp.status_code == 200
    cameras = resp.json()
    assert any(c["name"] == "front-door" for c in cameras)


# ---------------------------------------------------------------------------
# Preview endpoints
# ---------------------------------------------------------------------------

async def test_preview_404_for_missing_camera(client):
    resp = await client.get("/api/preview/nonexistent-cam/1700000000.0")
    assert resp.status_code == 404


async def test_preview_stats(client):
    resp = await client.get("/api/preview/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "hit_rate_pct" in data
    assert "cache_size" in data


async def test_preview_progress_empty(client):
    resp = await client.get("/api/preview/progress")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------

async def test_timeline_returns_gaps(client, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    # Two segments with a gap between them
    _insert_segment(db_path, "test-cam", 1700000000.0, 1700000010.0)
    _insert_segment(db_path, "test-cam", 1700000200.0, 1700000210.0)

    resp = await client.get(
        "/api/timeline",
        params={"camera": "test-cam", "start": 1700000000.0, "end": 1700000210.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) == 2
    assert len(data["gaps"]) >= 1
    # The internal gap should span ~190 seconds
    internal_gap = next(
        (g for g in data["gaps"] if g["start_ts"] == pytest.approx(1700000010.0, abs=1)),
        None,
    )
    assert internal_gap is not None
    assert internal_gap["duration"] == pytest.approx(190.0, abs=1)


async def test_timeline_empty_camera_no_segments(client):
    resp = await client.get(
        "/api/timeline",
        params={"camera": "no-such-cam", "start": 1700000000.0, "end": 1700001000.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["segments"] == []
    assert len(data["gaps"]) == 1  # whole range is a gap
    assert data["coverage_pct"] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Playback / gap snapping
# ---------------------------------------------------------------------------

async def test_playback_no_segments_returns_404(client):
    resp = await client.get(
        "/api/playback",
        params={"camera": "empty-cam", "ts": 1700000000.0},
    )
    assert resp.status_code == 404


async def test_playback_exact_hit(client, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    _insert_segment(db_path, "exact-cam", 1700005000.0, 1700005010.0)

    resp = await client.get(
        "/api/playback",
        params={"camera": "exact-cam", "ts": 1700005005.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["segment_start_ts"] == pytest.approx(1700005000.0)
    assert data["offset_sec"] == pytest.approx(5.0, abs=0.1)


async def test_playback_gap_snapping(client, monkeypatch):
    """Timestamp in a gap should snap to the nearest segment."""
    from app import config
    db_path = config.settings.database_path
    # Two segments separated by a gap; ts falls in the gap
    _insert_segment(db_path, "snap-cam", 1700010000.0, 1700010010.0)
    _insert_segment(db_path, "snap-cam", 1700010200.0, 1700010210.0)

    ts_in_gap = 1700010100.0  # midpoint of gap

    resp = await client.get(
        "/api/playback",
        params={"camera": "snap-cam", "ts": ts_in_gap},
    )
    assert resp.status_code == 200
    data = resp.json()
    # Should snap to one of the two segments
    seg_start = data["segment_start_ts"]
    assert seg_start == pytest.approx(1700010000.0, abs=1) or \
           seg_start == pytest.approx(1700010200.0, abs=1)


async def test_playback_gap_prefers_after(client, monkeypatch):
    """On equal distance, should prefer the segment that starts AFTER the gap."""
    from app import config
    db_path = config.settings.database_path
    _insert_segment(db_path, "prefer-after", 1700020000.0, 1700020010.0)
    _insert_segment(db_path, "prefer-after", 1700020110.0, 1700020120.0)

    ts_in_gap = 1700020060.0  # exactly midpoint

    resp = await client.get(
        "/api/playback",
        params={"camera": "prefer-after", "ts": ts_in_gap},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["segment_start_ts"] == pytest.approx(1700020110.0, abs=1)


# ---------------------------------------------------------------------------
# Timeline buckets — resolution contract and DB-backed preview lookup
# ---------------------------------------------------------------------------

async def test_timeline_buckets_resolution_source_auto_and_explicit(client):
    """resolution_source must be 'auto' when param omitted, 'explicit' when provided."""
    params_base = {"camera": "res-cam", "start": 1700000000.0, "end": 1700003600.0}

    resp_auto = await client.get("/api/timeline/buckets", params=params_base)
    assert resp_auto.status_code == 200
    data_auto = resp_auto.json()
    assert data_auto["resolution_source"] == "auto"
    assert "resolution" in data_auto
    assert data_auto["resolution"] > 0

    resp_explicit = await client.get(
        "/api/timeline/buckets",
        params={**params_base, "resolution": 120},
    )
    assert resp_explicit.status_code == 200
    data_explicit = resp_explicit.json()
    assert data_explicit["resolution_source"] == "explicit"
    assert data_explicit["resolution"] == 120


async def test_timeline_buckets_has_preview_from_db_not_filesystem(client, monkeypatch):
    """has_preview must be True when a DB preview row exists, even with no file on disk."""
    import sqlite3
    from app import config

    db_path = config.settings.database_path
    # Insert a segment covering 1700030000..1700030010
    _insert_segment(db_path, "db-preview-cam", 1700030000.0, 1700030010.0)

    # Insert a preview row for ts=1700030002.0 (no file created on disk)
    conn = sqlite3.connect(str(db_path))
    # Get the segment id just inserted
    seg_id = conn.execute(
        "SELECT id FROM segments WHERE camera = ? ORDER BY id DESC LIMIT 1",
        ("db-preview-cam",),
    ).fetchone()[0]
    conn.execute(
        """INSERT INTO previews (camera, ts, segment_id, image_path, width, height)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("db-preview-cam", 1700030002.0, seg_id,
         "db-preview-cam/2023-11-14/1700030002.00.jpg", 320, 180),
    )
    conn.commit()
    conn.close()

    resp = await client.get(
        "/api/timeline/buckets",
        params={
            "camera": "db-preview-cam",
            "start": 1700030000.0,
            "end": 1700030010.0,
            "resolution": 5,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    has_preview_values = [b["has_preview"] for b in data["buckets"]]
    # At least one bucket must report has_preview=True (from DB, not filesystem)
    assert any(has_preview_values), "Expected has_preview=True from DB row, got all False"


# ---------------------------------------------------------------------------
# Density endpoint
# ---------------------------------------------------------------------------

def _insert_event(db_path, camera, start_ts, end_ts, label="person", zones=None):
    """Insert a test event row directly into the DB."""
    import json
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


async def test_density_endpoint_returns_correct_shape(client):
    """GET /api/timeline/density returns DensityResponse shape."""
    resp = await client.get(
        "/api/timeline/density",
        params={"camera": "density-cam", "start": 1700000000.0, "end": 1700003600.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["camera"] == "density-cam"
    assert data["start_ts"] == pytest.approx(1700000000.0)
    assert data["end_ts"] == pytest.approx(1700003600.0)
    assert "bucket_sec" in data
    assert isinstance(data["buckets"], list)
    assert len(data["buckets"]) > 0
    # Each bucket has required fields
    bucket = data["buckets"][0]
    assert "ts" in bucket
    assert "counts" in bucket
    assert "total" in bucket
    assert "important" in bucket


async def test_density_endpoint_auto_resolution(client):
    """Omitting bucket_sec uses auto_resolution based on range."""
    resp = await client.get(
        "/api/timeline/density",
        params={"camera": "auto-res-cam", "start": 1700000000.0, "end": 1700003600.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    # 1h range → auto_resolution = 5s
    assert data["bucket_sec"] == 5


async def test_density_endpoint_respects_explicit_bucket_sec(client):
    """Explicit bucket_sec=30 is used verbatim."""
    resp = await client.get(
        "/api/timeline/density",
        params={
            "camera": "explicit-bucket-cam",
            "start": 1700000000.0,
            "end": 1700003600.0,
            "bucket_sec": 30,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["bucket_sec"] == 30
    # 1h / 30s = 120 buckets
    assert len(data["buckets"]) == 120


async def test_density_endpoint_counts_events(client):
    """Events in the range show up as non-zero totals in matching buckets."""
    from app import config
    db_path = config.settings.database_path
    _insert_event(db_path, "count-cam", 1700040010.0, 1700040020.0, label="car")

    resp = await client.get(
        "/api/timeline/density",
        params={
            "camera": "count-cam",
            "start": 1700040000.0,
            "end": 1700040060.0,
            "bucket_sec": 30,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    # First bucket [0, 30) contains the event
    first = data["buckets"][0]
    assert first["total"] == 1
    assert first["counts"].get("car") == 1


async def test_density_endpoint_important_flag(client):
    """Bucket containing a 'cat' event → important=True."""
    from app import config
    db_path = config.settings.database_path
    _insert_event(db_path, "important-cam", 1700050005.0, 1700050010.0, label="cat")

    resp = await client.get(
        "/api/timeline/density",
        params={
            "camera": "important-cam",
            "start": 1700050000.0,
            "end": 1700050030.0,
            "bucket_sec": 30,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["buckets"][0]["important"] is True


async def test_worker_one_query_per_camera_group(test_app, monkeypatch):
    """10 jobs across 2 cameras → exactly 2 DB execute_fetchall queries issued."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from app.services.preview_scheduler import PreviewJob, Priority
    from app.services.worker import _process_scheduler_jobs

    # 5 jobs for cam-a and 5 for cam-b (10 total, 2 camera groups)
    jobs = []
    for i in range(5):
        jobs.append(PreviewJob(
            priority=Priority.VIEWPORT, enqueued_at=0.0,
            bucket_ts=1700000000.0 + i * 2, camera="cam-a",
        ))
        jobs.append(PreviewJob(
            priority=Priority.VIEWPORT, enqueued_at=0.0,
            bucket_ts=1700000000.0 + i * 2, camera="cam-b",
        ))

    # Mock db returning no rows (no segments match — we only care about query count)
    mock_db = AsyncMock()
    mock_db.execute_fetchall = AsyncMock(return_value=[])
    mock_db.executemany = AsyncMock()
    mock_db.execute = AsyncMock()
    mock_db.commit = AsyncMock()

    @asynccontextmanager
    async def mock_get_db():
        yield mock_db

    monkeypatch.setattr("app.services.worker.get_db", mock_get_db)

    await _process_scheduler_jobs(jobs)

    # Must have made exactly 2 execute_fetchall calls — one per camera group
    assert mock_db.execute_fetchall.call_count == 2
