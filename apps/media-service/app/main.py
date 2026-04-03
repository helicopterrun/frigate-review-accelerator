from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.frame import router as frame_router
from app.api.snapshot import router as snapshot_router
from app.api.preview import router as preview_router
from app.api.clip import router as clip_router
from app.services.cache_manager import ensure_cache_dir
from app.config import CACHE_DIR, MOCK_MODE, FRIGATE_URL

app = FastAPI(title="Frigate Review Accelerator Media Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

ensure_cache_dir()

# Register snapshot route BEFORE static mount (it handles /media/snapshot/{id})
app.include_router(snapshot_router)

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
app.include_router(preview_router)
app.include_router(clip_router)
