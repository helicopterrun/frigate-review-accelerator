from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.frame import router as frame_router
from app.services.cache_manager import ensure_cache_dir
from app.config import CACHE_DIR, MOCK_MODE, FRIGATE_URL

app = FastAPI(title="Frigate Review Accelerator Media Service")

ensure_cache_dir()

# Serve cached media files at /media/
app.mount("/media", StaticFiles(directory=CACHE_DIR), name="media")


@app.get("/health")
async def health():
    from app.services.frigate_client import check_frigate_health

    frigate_ok = False
    if not MOCK_MODE:
        frigate_ok = await check_frigate_health()

    return {
        "ok": True,
        "service": "media-service",
        "mock_mode": MOCK_MODE,
        "frigate_url": FRIGATE_URL,
        "frigate_reachable": frigate_ok,
    }


app.include_router(frame_router)
