import os
import hashlib
from pathlib import Path

from app.config import CACHE_DIR


def _cache_key(camera: str, timestamp: float, mode: str, fmt: str, width: int | None) -> str:
    raw = f"{camera}:{timestamp:.4f}:{mode}:{fmt}:{width or 'auto'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _cache_path(camera: str, timestamp: float, mode: str, fmt: str, width: int | None) -> Path:
    key = _cache_key(camera, timestamp, mode, fmt, width)
    return Path(CACHE_DIR) / camera / f"{key}.{fmt}"


def get_cached(camera: str, timestamp: float, mode: str, fmt: str, width: int | None) -> str | None:
    path = _cache_path(camera, timestamp, mode, fmt, width)
    if path.exists():
        return f"/media/{path.relative_to(CACHE_DIR)}"
    return None


def store_cached(
    camera: str, timestamp: float, mode: str, fmt: str, width: int | None, data: bytes
) -> str:
    path = _cache_path(camera, timestamp, mode, fmt, width)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return f"/media/{path.relative_to(CACHE_DIR)}"


def ensure_cache_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)
