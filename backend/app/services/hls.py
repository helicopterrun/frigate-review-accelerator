"""Frigate VOD URL construction and reachability cache.

Pure utilities shared by timeline.py and preview.py.
_build_hls_url is a pure function — no DB calls, no async, no side effects.
_resolve_hls_url does a HEAD request on first use per camera, then caches
reachability for _HLS_CACHE_TTL_SEC seconds to avoid per-seek latency.
"""

import time as _time

import httpx

from app.config import settings

# ---------------------------------------------------------------------------
# Reachability cache
# ---------------------------------------------------------------------------
# Stores (reachable: bool, timestamp: float) tuples.
# Positive entries (True) are kept for _HLS_CACHE_TTL_SEC seconds.
# Negative entries (False) are kept for HLS_NEGATIVE_CACHE_TTL seconds so that
# after a Frigate restart clients stop getting stale positive hits quickly,
# without hammering the API on every seek.
_hls_reachable_cache: dict[str, tuple[bool, float]] = {}
_HLS_CACHE_TTL_SEC = 30.0
HLS_NEGATIVE_CACHE_TTL = 2.0


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------
# Playback = Frigate VOD ONLY. See CLAUDE.md architectural invariant.
# Path shape verified against Frigate docs and hls.py working integration.
# No custom stitching. No manual playlist construction.
def _build_hls_url(camera: str, requested_ts: float, seg_start: float) -> str:
    """Construct a Frigate VOD HLS playlist URL.

    Pure function — no DB calls, no async, no side effects.
    Window starts 30s before requested_ts (or at seg_start, whichever is later)
    and spans frigate_vod_window_sec seconds (default 86400 = 24 h).

    A 24-hour window is safe because Frigate's /api/vod/ endpoint stitches
    existing MP4 segments on demand from the recordings filesystem — it does
    not transcode or store a new file.  Requesting a larger window only changes
    the playlist length; segments that have not yet been recorded are simply
    absent from the manifest.  The frontend's hls.js instance therefore plays
    everything available and can reload the source when it approaches the end
    without the user ever seeing a stop.
    """
    window_start = max(seg_start, requested_ts - 30)
    window_end = window_start + settings.frigate_vod_window_sec
    return (
        f"{settings.frigate_api_url}/api/vod/{camera}"
        f"/start/{window_start:.0f}/end/{window_end:.0f}"
    )


# ---------------------------------------------------------------------------
# Reachability check
# ---------------------------------------------------------------------------
async def _resolve_hls_url(camera: str, requested_ts: float, seg_start: float) -> str | None:
    """Build the HLS URL and verify Frigate VOD is reachable.

    Returns the URL if Frigate responds 2xx, None otherwise.
    Never raises — any failure yields None so /api/playback never breaks.

    Uses a per-camera reachability cache (_hls_reachable_cache) with a
    _HLS_CACHE_TTL_SEC TTL to avoid a HEAD request on every seek.  Cache is
    NOT invalidated on failure — a failed check simply lets the TTL expire
    naturally, avoiding thrashing when Frigate is flapping.
    """
    if not settings.frigate_vod_enabled:
        return None
    now = _time.time()
    cached = _hls_reachable_cache.get(camera)
    if cached is not None:
        reachable, ts = cached
        ttl = _HLS_CACHE_TTL_SEC if reachable else HLS_NEGATIVE_CACHE_TTL
        if ts + ttl > now:
            # Cache hit — return URL for positive entry, None for negative entry
            return _build_hls_url(camera, requested_ts, seg_start) if reachable else None
    url = _build_hls_url(camera, requested_ts, seg_start)
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.head(url)
            if r.status_code < 300:
                _hls_reachable_cache[camera] = (True, now)
                return url
    except Exception:
        pass
    # Store negative result with short TTL so stale positive entries expire quickly
    # after Frigate restarts or becomes temporarily unreachable.
    _hls_reachable_cache[camera] = (False, now)
    return None
