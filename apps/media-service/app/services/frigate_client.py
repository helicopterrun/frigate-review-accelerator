import httpx

from app.config import FRIGATE_URL

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=FRIGATE_URL, timeout=10.0)
    return _client


async def fetch_snapshot(camera: str, timestamp: float) -> bytes | None:
    """Fetch a snapshot from Frigate's API for the given camera and timestamp."""
    client = get_client()
    try:
        # Try the latest.jpg endpoint with timestamp parameter
        resp = await client.get(
            f"/api/{camera}/latest.jpg",
            params={"ts": str(timestamp)},
        )
        if resp.status_code == 200 and len(resp.content) > 0:
            return resp.content
    except httpx.HTTPError:
        pass

    try:
        # Fallback: try the preview endpoint
        resp = await client.get(
            f"/api/preview/{camera}/{timestamp}",
        )
        if resp.status_code == 200 and len(resp.content) > 0:
            return resp.content
    except httpx.HTTPError:
        pass

    return None


async def check_frigate_health() -> bool:
    client = get_client()
    try:
        resp = await client.get("/api/version")
        return resp.status_code == 200
    except httpx.HTTPError:
        return False
