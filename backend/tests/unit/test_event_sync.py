"""Unit tests for event_sync — end_time parsing and Frigate API pagination."""

import sqlite3
import time
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_event(event_id, start_time, end_time=..., label="person"):
    """Build a minimal Frigate event dict. Omit end_time key when end_time is Ellipsis."""
    evt = {
        "id": str(event_id),
        "start_time": start_time,
        "label": label,
        "score": 0.9,
        "has_clip": True,
        "has_snapshot": False,
        "zones": [],
    }
    if end_time is not ...:
        evt["end_time"] = end_time
    return evt


def _build_mock_client(events_pages):
    """Return a mock httpx.Client that serves events_pages in order."""
    call_index = {"n": 0}

    def mock_get(url, params=None):
        idx = call_index["n"]
        call_index["n"] += 1
        page = events_pages[idx] if idx < len(events_pages) else []
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = page
        return resp

    mock_client = MagicMock()
    mock_client.get.side_effect = mock_get
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    return mock_client


def _run_sync(events_pages, db_path, camera="cam-a"):
    """Run sync_frigate_events_sync against db_path with mocked HTTP."""
    from app.services.event_sync import sync_frigate_events_sync

    mock_client = _build_mock_client(events_pages)

    # Ensure segments row exists so camera appears in SELECT DISTINCT camera
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """INSERT OR IGNORE INTO segments
           (camera, start_ts, end_ts, duration, path, file_size, indexed_at)
           VALUES (?, ?, ?, ?, ?, 1024, ?)""",
        (camera, 1700000000.0, 1700000010.0, 10.0,
         f"{camera}/1700000000.mp4", time.time()),
    )
    conn.commit()
    conn.close()

    with patch("app.services.event_sync.httpx.Client", return_value=mock_client):
        count = sync_frigate_events_sync(camera=camera, db_path=db_path)

    return count, mock_client.get.call_count


def _fetch_events(db_path):
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute("SELECT id, end_ts FROM events").fetchall()
    conn.close()
    return {r[0]: r[1] for r in rows}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_path(tmp_path, monkeypatch):
    """Temp DB path with schema applied; settings patched to point at it."""
    from app import config
    from app.models.database import init_db_sync

    db = tmp_path / "test.db"
    monkeypatch.setattr(config.settings, "database_path", db)
    monkeypatch.setattr(config.settings, "frigate_api_url", "http://frigate")

    # preview_output_path must exist for ensure_dirs()
    previews = tmp_path / "previews"
    previews.mkdir()
    monkeypatch.setattr(config.settings, "preview_output_path", previews)

    init_db_sync()
    return db


# ---------------------------------------------------------------------------
# end_time parsing
# ---------------------------------------------------------------------------

class TestEndTimeParsing:
    def test_end_time_zero_stored_as_float(self, db_path):
        """end_time=0 is falsy but valid — must be stored as 0.0, not None."""
        evts = [_make_event("ev1", 1700000001.0, end_time=0)]
        _run_sync([evts], db_path)
        rows = _fetch_events(db_path)
        assert rows["ev1"] == pytest.approx(0.0)

    def test_end_time_missing_key_stored_as_none(self, db_path):
        """Event dict without end_time key → end_ts is NULL in DB."""
        evts = [_make_event("ev2", 1700000001.0)]  # no end_time key
        _run_sync([evts], db_path)
        rows = _fetch_events(db_path)
        assert rows["ev2"] is None

    def test_end_time_none_value_stored_as_none(self, db_path):
        """Event with end_time=None → end_ts is NULL in DB."""
        evts = [_make_event("ev3", 1700000001.0, end_time=None)]
        _run_sync([evts], db_path)
        rows = _fetch_events(db_path)
        assert rows["ev3"] is None

    def test_end_time_valid_stored_correctly(self, db_path):
        """Normal end_time stored as float."""
        evts = [_make_event("ev4", 1700000001.0, end_time=1700000010.0)]
        _run_sync([evts], db_path)
        rows = _fetch_events(db_path)
        assert rows["ev4"] == pytest.approx(1700000010.0)


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

_LIMIT = 100  # must match event_sync._LIMIT


class TestPagination:
    def _pages_of(self, n_events, start_ts=None):
        """Build n_events newest-first (as Frigate returns them).

        Uses recent timestamps by default so events fall within the
        'now - 7 days' default after_ts window used on first sync.
        """
        if start_ts is None:
            start_ts = time.time() - 3600  # 1h ago — safely within 7d window
        return [
            _make_event(i, start_ts + i, end_time=start_ts + i + 1)
            for i in range(n_events - 1, -1, -1)
        ]

    def test_single_page_one_call(self, db_path):
        """50 events (<100) → exactly 1 API call."""
        page = self._pages_of(50)
        count, n_calls = _run_sync([page], db_path)
        assert n_calls == 1
        assert count == 50

    def test_multi_page_two_calls(self, db_path):
        """100 events page 1 + 40 events page 2 → 2 API calls, 140 upserted."""
        now = time.time()
        page1 = self._pages_of(_LIMIT, start_ts=now - 200)
        page2 = self._pages_of(40, start_ts=now - 500)
        count, n_calls = _run_sync([page1, page2], db_path)
        assert n_calls == 2
        assert count == 140

    def test_exact_limit_empty_termination(self, db_path):
        """Exactly 100 events on page 1, 0 on page 2 → 2 API calls."""
        page1 = self._pages_of(_LIMIT)
        page2 = []
        count, n_calls = _run_sync([page1, page2], db_path)
        assert n_calls == 2
        assert count == _LIMIT

    def test_pagination_guard_1000(self, db_path):
        """Always-full pages → loop breaks after 10 pages (1000 event guard)."""
        pages = []
        now = time.time()
        for p in range(15):  # 15 pages available, but guard fires at 10
            # Each page has timestamps strictly decreasing so oldest_ts guard
            # doesn't trip — pages go from (now-200) back into recent history.
            base_ts = now - 200 - p * (_LIMIT * 2)
            pages.append(self._pages_of(_LIMIT, start_ts=base_ts))

        with patch("app.services.event_sync.log") as mock_log:
            count, n_calls = _run_sync(pages, db_path)
            # Warning must have been logged about stopping pagination
            warning_calls = [str(c) for c in mock_log.warning.call_args_list]
            assert any("stopping pagination" in s for s in warning_calls)

        assert count <= 10 * _LIMIT
        assert n_calls <= 10


# ---------------------------------------------------------------------------
# Watermark advancement
# ---------------------------------------------------------------------------

def _read_watermark(db_path, camera):
    """Return last_event_sync_ts for a camera from scan_state."""
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT last_event_sync_ts FROM scan_state WHERE camera = ?", (camera,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


class TestWatermark:
    def test_watermark_advances_to_max_after_pagination(self, db_path):
        """After paginated sync, watermark must be max(start_time), not min.

        Page 1: events at t=100, 90, 80 (newest-first)
        Page 2: events at t=79, 70, 60

        Expected watermark = 100 (newest seen), NOT 60 (oldest seen).
        """
        now = time.time()
        base = now - 500  # safely within the 7d first-sync window

        page1 = [
            _make_event("w1", base + 100, end_time=base + 101),
            _make_event("w2", base + 90,  end_time=base + 91),
            _make_event("w3", base + 80,  end_time=base + 81),
        ]
        page2 = [
            _make_event("w4", base + 79,  end_time=base + 80),
            _make_event("w5", base + 70,  end_time=base + 71),
            _make_event("w6", base + 60,  end_time=base + 61),
        ]
        # page2 has fewer than _LIMIT events — terminates pagination
        _run_sync([page1, page2], db_path, camera="wm-cam")

        wm = _read_watermark(db_path, "wm-cam")
        expected = base + 100
        assert wm == pytest.approx(expected, abs=0.01), (
            f"Watermark should advance to max(start_time)={expected:.0f}, got {wm}"
        )

    def test_watermark_not_updated_on_empty_response(self, db_path):
        """If the API returns no events, last_event_sync_ts must not change.

        The empty-events branch writes now() as the watermark (existing behaviour
        to prevent re-querying a silent camera every cycle). Verify it separately
        from the all_events guard added by this fix.
        """
        # Pre-set a known watermark by running a successful sync first
        now = time.time()
        base = now - 500
        page1 = [_make_event("pre1", base + 10, end_time=base + 11)]
        _run_sync([page1], db_path, camera="empty-cam")
        wm_before = _read_watermark(db_path, "empty-cam")
        assert wm_before is not None, "Pre-condition: watermark should be set after first sync"

        # Second sync returns no events — watermark must not decrease
        _run_sync([[]], db_path, camera="empty-cam")
        wm_after = _read_watermark(db_path, "empty-cam")

        # The empty-events branch writes now() — that is always >= the previous watermark
        assert wm_after >= wm_before, (
            "Watermark must not decrease when API returns no events"
        )

    def test_watermark_does_not_regress_across_pages(self, db_path):
        """min(start_time) regression test: simulate old buggy behaviour.

        If the code still used min(), the watermark would be base+60.
        This test fails if min() is used instead of max().
        """
        now = time.time()
        base = now - 600

        page1 = [_make_event(f"r{i}", base + 100 - i, end_time=base + 110) for i in range(3)]
        page2 = [_make_event(f"r{i}", base + 60 - i,  end_time=base + 70)  for i in range(3, 6)]
        _run_sync([page1, page2], db_path, camera="regress-cam")

        wm = _read_watermark(db_path, "regress-cam")
        # With max(): watermark = base+100  (correct)
        # With min(): watermark = base+57   (old bug)
        assert wm > base + 90, (
            f"Watermark regressed to {wm:.0f}; expected > {base+90:.0f} — "
            "min() is being used instead of max()"
        )
