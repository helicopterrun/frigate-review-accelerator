"""Integration tests for Frigate HLS VOD playback integration."""

import sqlite3
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import pytest_asyncio

pytestmark = pytest.mark.asyncio


def _insert_segment(db_path, camera, start_ts, end_ts, previews_generated=1):
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


# ---------------------------------------------------------------------------
# HLS URL present when Frigate is reachable
# ---------------------------------------------------------------------------

async def test_playback_hls_url_present(client, test_app, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    start_ts = 1700100000.0
    end_ts = start_ts + 20.0
    _insert_segment(db_path, "hls-test-cam", start_ts, end_ts)

    mock_response = MagicMock()
    mock_response.status_code = 200

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(return_value=mock_response)

    with patch("app.routers.timeline.httpx.AsyncClient", return_value=mock_client):
        resp = await client.get(
            "/api/playback",
            params={"camera": "hls-test-cam", "ts": start_ts + 5.0},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert "hls_url" in data
    assert data["hls_url"] is not None
    assert "/vod/hls-test-cam/start/" in data["hls_url"]
    assert config.settings.frigate_api_url in data["hls_url"]


# ---------------------------------------------------------------------------
# hls_url is None when Frigate is down — /api/playback must still return 200
# ---------------------------------------------------------------------------

async def test_playback_hls_url_none_when_frigate_down(client, test_app, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    start_ts = 1700200000.0
    end_ts = start_ts + 20.0
    _insert_segment(db_path, "hls-down-cam", start_ts, end_ts)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

    with patch("app.routers.timeline.httpx.AsyncClient", return_value=mock_client):
        resp = await client.get(
            "/api/playback",
            params={"camera": "hls-down-cam", "ts": start_ts + 5.0},
        )

    assert resp.status_code == 200, "Frigate being down must NOT break /api/playback"
    data = resp.json()
    assert "hls_url" in data
    assert data["hls_url"] is None


# ---------------------------------------------------------------------------
# /api/segment/{id}/info endpoint
# ---------------------------------------------------------------------------

async def test_segment_info_endpoint(client, test_app):
    from app import config
    db_path = config.settings.database_path
    start_ts = 1700300000.0
    end_ts = start_ts + 20.0
    _insert_segment(db_path, "info-cam", start_ts, end_ts)

    # Get the segment ID
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT id FROM segments WHERE camera = 'info-cam' AND start_ts = ?",
        (start_ts,),
    ).fetchone()
    conn.close()
    assert row is not None
    seg_id = row[0]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(return_value=mock_response)

    with patch("app.routers.timeline.httpx.AsyncClient", return_value=mock_client):
        resp = await client.get(f"/api/segment/{seg_id}/info")

    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == seg_id
    assert data["camera"] == "info-cam"
    assert "start_ts" in data
    assert "end_ts" in data
    assert "duration" in data
    assert data["stream_url"] == f"/api/segment/{seg_id}/stream"


async def test_segment_info_not_found(client):
    resp = await client.get("/api/segment/999999/info")
    assert resp.status_code == 404
