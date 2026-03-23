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

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
        resp = await client.get(
            "/api/playback",
            params={"camera": "hls-test-cam", "ts": start_ts + 5.0},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert "hls_url" in data
    assert data["hls_url"] is not None
    assert "/api/vod/hls-test-cam/start/" in data["hls_url"]
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

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
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

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
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


# ---------------------------------------------------------------------------
# Negative reachability cache TTL
# ---------------------------------------------------------------------------

async def test_negative_cache_stored_on_failure(monkeypatch):
    """A failed reachability check stores a (False, timestamp) tuple in the cache."""
    from app.services import hls as hls_mod

    # Ensure the camera is not already cached
    hls_mod._hls_reachable_cache.pop("neg-ttl-cam", None)

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(side_effect=httpx.ConnectError("down"))

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
        result = await hls_mod._resolve_hls_url("neg-ttl-cam", 1700000000.0, 1699999990.0)

    assert result is None
    cached = hls_mod._hls_reachable_cache.get("neg-ttl-cam")
    assert cached is not None, "Failed check must be stored in the cache"
    reachable, ts = cached
    assert reachable is False, "Negative cache entry must have reachable=False"


async def test_negative_cache_returns_none_within_ttl(monkeypatch):
    """Within the negative TTL, _resolve_hls_url returns None without a HEAD request."""
    import time
    from app.services import hls as hls_mod

    # Inject a fresh negative cache entry
    hls_mod._hls_reachable_cache["neg-hit-cam"] = (False, time.time())

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock()

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
        result = await hls_mod._resolve_hls_url("neg-hit-cam", 1700000000.0, 1699999990.0)

    assert result is None
    mock_client.head.assert_not_called()  # no HEAD request during negative TTL


async def test_positive_cache_entry_format(monkeypatch):
    """A successful check stores a (True, timestamp) tuple in the cache."""
    from app.services import hls as hls_mod

    hls_mod._hls_reachable_cache.pop("pos-fmt-cam", None)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(return_value=mock_response)

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
        result = await hls_mod._resolve_hls_url("pos-fmt-cam", 1700000000.0, 1699999990.0)

    assert result is not None
    cached = hls_mod._hls_reachable_cache.get("pos-fmt-cam")
    assert cached is not None
    reachable, ts = cached
    assert reachable is True, "Positive cache entry must have reachable=True"


# ---------------------------------------------------------------------------
# HLS window is at least 86000 seconds wide (24-hour default)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# POST /api/admin/invalidate-hls-cache clears the reachability cache
# ---------------------------------------------------------------------------

async def test_invalidate_hls_cache_clears_entries(client, test_app):
    """Calling the endpoint removes all entries from _hls_reachable_cache."""
    import time
    from app.services import hls as hls_mod

    # Populate cache with fake negative entries for two cameras
    hls_mod._hls_reachable_cache["cam-a"] = (False, time.time())
    hls_mod._hls_reachable_cache["cam-b"] = (False, time.time())
    assert len(hls_mod._hls_reachable_cache) >= 2

    resp = await client.post("/api/admin/invalidate-hls-cache")

    assert resp.status_code == 200
    data = resp.json()
    assert data["cleared"] is True
    assert data["entries_removed"] >= 2
    assert len(hls_mod._hls_reachable_cache) == 0


# ---------------------------------------------------------------------------
# Negative cache TTL is 2.0s (defence-in-depth: expires within one health-poll cycle)
# ---------------------------------------------------------------------------

async def test_negative_cache_ttl_is_2s():
    """HLS_NEGATIVE_CACHE_TTL must be 2.0 so stale entries expire within one health-poll cycle."""
    from app.services.hls import HLS_NEGATIVE_CACHE_TTL
    assert HLS_NEGATIVE_CACHE_TTL == 2.0, (
        f"Expected HLS_NEGATIVE_CACHE_TTL == 2.0, got {HLS_NEGATIVE_CACHE_TTL}. "
        "This value was reduced from 5.0 to ensure stale negative entries expire "
        "within a single 2s health-poll cycle after a Frigate restart."
    )


async def test_hls_url_has_24h_window(client, test_app, monkeypatch):
    from app import config
    db_path = config.settings.database_path
    start_ts = 1700400000.0
    end_ts = start_ts + 20.0
    _insert_segment(db_path, "window-cam", start_ts, end_ts)

    mock_response = MagicMock()
    mock_response.status_code = 200

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.head = AsyncMock(return_value=mock_response)

    with patch("app.services.hls.httpx.AsyncClient", return_value=mock_client):
        resp = await client.get(
            "/api/playback",
            params={"camera": "window-cam", "ts": start_ts + 5.0},
        )

    assert resp.status_code == 200
    hls_url = resp.json()["hls_url"]
    assert hls_url is not None

    # Parse /start/{s}/end/{e} from the URL and confirm window >= 86000s
    import re
    m = re.search(r"/start/(\d+)/end/(\d+)", hls_url)
    assert m is not None, f"Could not parse start/end from HLS URL: {hls_url}"
    window_sec = int(m.group(2)) - int(m.group(1))
    assert window_sec >= 86000, (
        f"Expected HLS window >= 86000s (24h), got {window_sec}s in URL: {hls_url}"
    )
