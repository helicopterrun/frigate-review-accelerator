"""Frigate Review Accelerator — FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.models.database import init_db_sync
from app.routers import timeline, preview
from app.services.worker import start_worker, stop_worker

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

    # Initialize database
    settings.ensure_dirs()
    init_db_sync()

    # Start background indexer + preview generator
    start_worker()

    yield

    # Shutdown
    await stop_worker()
    log.info("Shutdown complete")


app = FastAPI(
    title="Frigate Review Accelerator",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow the Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(timeline.router)
app.include_router(preview.router)
