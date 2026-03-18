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
