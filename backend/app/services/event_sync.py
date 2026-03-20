"""Frigate event sync — polls the Frigate API and upserts into the local events table.

Designed to run in the background worker loop after indexing. On each cycle it
checks `last_event_sync_ts` per camera from `scan_state` and fetches only
events newer than that, keeping API calls small.
"""

import json
import logging
import sqlite3
import time

import httpx

from app.config import settings

log = logging.getLogger(__name__)

# Frigate event fields we care about
_LIMIT = 100  # events per API page


def _get_last_sync_ts(conn: sqlite3.Connection, camera: str) -> float:
    """Return last_event_sync_ts for a camera, or 0 if never synced."""
    row = conn.execute(
        "SELECT last_event_sync_ts FROM scan_state WHERE camera = ?", (camera,)
    ).fetchone()
    if row and row[0] is not None:
        return float(row[0])
    return 0.0


def _write_last_sync_ts(conn: sqlite3.Connection, camera: str, ts: float) -> None:
    conn.execute(
        """INSERT INTO scan_state (camera, last_scanned_ts, last_event_sync_ts)
           VALUES (?, 0, ?)
           ON CONFLICT(camera) DO UPDATE SET last_event_sync_ts = excluded.last_event_sync_ts""",
        (camera, ts),
    )


def sync_frigate_events_sync(camera: str | None = None, db_path=None) -> int:
    """Fetch events from Frigate API and upsert into local events table.

    Args:
        camera:  If provided, sync only this camera. None = all cameras.
        db_path: Override DB path (uses settings default).

    Returns number of events upserted.
    """
    from app.models.database import init_db_sync
    db_path = db_path or settings.database_path
    init_db_sync()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row

    # Get cameras to sync
    if camera:
        cameras = [camera]
    else:
        rows = conn.execute("SELECT DISTINCT camera FROM segments").fetchall()
        cameras = [r[0] for r in rows]

    if not cameras:
        conn.close()
        return 0

    now = time.time()
    total_synced = 0

    try:
        with httpx.Client(timeout=10.0) as client:
            for cam in cameras:
                last_sync = _get_last_sync_ts(conn, cam)
                after_ts = last_sync if last_sync > 0 else (now - 86400 * 7)  # default: 7 days back on first sync

                try:
                    resp = client.get(
                        f"{settings.frigate_api_url}/api/events",
                        params={
                            "camera": cam,
                            "limit": _LIMIT,
                            "after": int(after_ts),
                        },
                    )
                    resp.raise_for_status()
                    events = resp.json()
                except httpx.HTTPError as exc:
                    log.warning("Event sync failed for camera %s: %s", cam, exc)
                    continue

                if not events:
                    _write_last_sync_ts(conn, cam, now)
                    conn.commit()
                    continue

                rows_to_upsert = []
                for evt in events:
                    try:
                        zones_json = json.dumps(evt.get("zones", []))
                        rows_to_upsert.append((
                            str(evt["id"]),
                            cam,
                            float(evt.get("start_time", 0)),
                            float(evt["end_time"]) if evt.get("end_time") else None,
                            str(evt.get("label", "unknown")),
                            float(evt["score"]) if evt.get("score") is not None else None,
                            int(bool(evt.get("has_clip", False))),
                            int(bool(evt.get("has_snapshot", False))),
                            now,
                            zones_json,
                        ))
                    except (KeyError, TypeError, ValueError) as exc:
                        log.debug("Skipping malformed event %s: %s", evt.get("id"), exc)

                if rows_to_upsert:
                    conn.executemany(
                        """INSERT INTO events
                           (id, camera, start_ts, end_ts, label, score, has_clip, has_snapshot, synced_at, zones)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(id) DO UPDATE SET
                             end_ts       = excluded.end_ts,
                             score        = excluded.score,
                             has_clip     = excluded.has_clip,
                             has_snapshot = excluded.has_snapshot,
                             synced_at    = excluded.synced_at,
                             zones        = excluded.zones""",
                        rows_to_upsert,
                    )
                    total_synced += len(rows_to_upsert)

                _write_last_sync_ts(conn, cam, now)
                conn.commit()
                log.debug("Synced %d events for camera %s", len(rows_to_upsert), cam)

    finally:
        conn.close()

    if total_synced:
        log.info("Event sync complete: %d events across %d cameras", total_synced, len(cameras))
    return total_synced


async def sync_frigate_events(camera: str | None = None) -> int:
    """Async wrapper for event sync — runs in thread pool."""
    import asyncio
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, sync_frigate_events_sync, camera)
