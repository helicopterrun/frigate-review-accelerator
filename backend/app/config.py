"""Application configuration loaded from environment / .env file."""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # Frigate integration
    frigate_recordings_path: Path = Path("/media/frigate/recordings")
    frigate_api_url: str = "http://localhost:5000"

    # Local storage
    preview_output_path: Path = Path("./data/previews")
    database_path: Path = Path("./data/accelerator.db")

    # Preview generation
    preview_interval_sec: int = 2
    preview_width: int = 320
    preview_quality: int = 5  # ffmpeg JPEG quality (1-31, lower = better)
    # Number of worker threads for concurrent preview generation.
    # Keep at 2 on single-iGPU systems — VAAPI does not parallelize
    # across concurrent ffmpeg processes. The _vaapi_semaphore in
    # preview_generator.py provides additional protection regardless
    # of this setting.
    preview_workers: int = 2

    # Preview prioritization
    # Only eagerly generate previews for segments newer than this many hours.
    # Segments outside this window are crawled slowly in the background.
    preview_recency_hours: int = 168

    # Whether to crawl older segments at all (disable to reduce disk/CPU load)
    preview_background_enabled: bool = True

    # Segments per background crawl cycle (runs every BACKGROUND_INTERVAL worker loops)
    preview_background_batch: int = 100

    # Scanning
    scan_interval_sec: int = 30

    # CORS — list of allowed origins; defaults cover Vite dev + common alternatives
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Preview retention — delete previews older than this many days (0 = keep forever)
    preview_retention_days: int = 30

    # Frigate VOD/HLS playback
    frigate_vod_enabled: bool = True
    frigate_vod_window_sec: int = 86400  # width of HLS window to request from Frigate (24 h)

    # Labels that trigger "important" flag in density buckets.
    # Phase 1: label-only rules. Phase 2 adds zone-based rules.
    # Override via IMPORTANT_LABELS='["cat","bird","bear"]' in .env
    important_labels: list[str] = ["cat", "bird", "bear", "horse"]

    def ensure_dirs(self):
        """Create required directories if they don't exist."""
        self.preview_output_path.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
