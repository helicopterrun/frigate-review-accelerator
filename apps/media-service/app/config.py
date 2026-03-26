import os

FRIGATE_URL = os.environ.get("FRIGATE_URL", "http://192.168.50.207:5000")
CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "./media_cache")
MOCK_MODE = os.environ.get("MOCK_MODE", "false").lower() in ("true", "1", "yes")
