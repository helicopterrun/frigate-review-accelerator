"""Proxy and cache Frigate event snapshots."""

from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from app.config import CACHE_DIR, MOCK_MODE
from app.services.frigate_client import get_client
from app.services.mock_frames import generate_mock_frame

router = APIRouter(tags=["snapshot"])

SNAPSHOT_CACHE_DIR = Path(CACHE_DIR) / "_snapshots"


@router.get("/media/snapshot/{event_id}")
async def get_snapshot(event_id: str):
    """Proxy a Frigate event snapshot, caching it on disk."""
    # Check cache
    cached_path = SNAPSHOT_CACHE_DIR / f"{event_id}.jpg"
    if cached_path.exists():
        return FileResponse(cached_path, media_type="image/jpeg")

    # Fetch from Frigate
    if not MOCK_MODE:
        try:
            client = get_client()
            resp = await client.get(f"/api/events/{event_id}/snapshot.jpg")
            if resp.status_code == 200 and len(resp.content) > 100:
                SNAPSHOT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cached_path.write_bytes(resp.content)
                return FileResponse(cached_path, media_type="image/jpeg")
        except Exception:
            pass

    # Mock fallback — generate a placeholder
    import time
    mock_data = generate_mock_frame("snapshot", time.time(), 320, "jpg")
    SNAPSHOT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path.write_bytes(mock_data)
    return FileResponse(cached_path, media_type="image/jpeg")
