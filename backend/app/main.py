"""Frigate Review Accelerator — FastAPI application entry point."""

import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.models.database import init_db_sync
from app.routers import timeline, preview
from app.routers.admin import router as admin_router
from app.services.worker import start_worker, stop_worker, set_preview_executor
from app.services.coverage import populate_from_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    log.info("Starting Frigate Review Accelerator")
    log.info("  Recordings: %s", settings.frigate_recordings_path)
    log.info("  Previews:   %s", settings.preview_output_path)
    log.info("  Database:   %s", settings.database_path)
    log.info("  Frigate:    %s", settings.frigate_api_url)
    if not settings.admin_secret:
        log.warning("Admin endpoints are unauthenticated — set ADMIN_SECRET in .env")

    # Initialize database
    settings.ensure_dirs()
    init_db_sync()

    # Populate in-memory coverage index from existing segments (one-time O(n))
    covered = populate_from_db()
    log.info("Coverage index: loaded %d segments", covered)

    # Create bounded executor for preview generation (preview_workers from config)
    executor = ThreadPoolExecutor(
        max_workers=settings.preview_workers,
        thread_name_prefix="preview-worker",
    )
    log.info("Preview executor: %d worker thread(s)", settings.preview_workers)
    set_preview_executor(executor)

    # Start background indexer + preview generator
    start_worker()

    yield

    # Shutdown
    await stop_worker()
    executor.shutdown(wait=False)
    log.info("Shutdown complete")


app = FastAPI(
    title="Frigate Review Accelerator",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — origins from config (set CORS_ORIGINS in .env to override)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(timeline.router)
app.include_router(preview.router)
app.include_router(admin_router)
