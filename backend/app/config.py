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
    preview_workers: int = 2

    # Scanning
    scan_interval_sec: int = 30

    def ensure_dirs(self):
        """Create required directories if they don't exist."""
        self.preview_output_path.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
