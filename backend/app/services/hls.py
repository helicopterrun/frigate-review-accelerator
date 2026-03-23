"""Frigate VOD URL construction and reachability cache.

Pure utilities shared by timeline.py and preview.py.
_build_hls_url is a pure function — no DB calls, no async, no side effects.
_resolve_hls_url does a HEAD request on first use per camera, then caches
reachability to avoid per-seek latency.

Positive results are cached for _HLS_CACHE_TTL_SEC (30s).
Negative results use exponential backoff: 2s, 4s, 8s … capped at 60s,
so a sustained Frigate outage does not produce a HEAD request on every seek.
"""

import time as _time

import httpx

from app.config import settings

# ---------------------------------------------------------------------------
# Reachability cache
# ---------------------------------------------------------------------------
# Cache entries: (reachable: bool, ts: float, fail_count: int)
# fail_count is 0 on success and monotonically increments on each failure.
_hls_reachable_cache: dict[str, tuple[bool, float, int]] = {}
_HLS_CACHE_TTL_SEC = 30.0


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

    Uses a per-camera reachability cache (_hls_reachable_cache).  Positive
    results are cached for _HLS_CACHE_TTL_SEC (30s).  Negative results use
    exponential backoff: ttl = min(2 * (2 ** fail_count), 60), giving
    2s, 4s, 8s, 16s, 32s, 60s (capped) across successive failures.  This
    keeps HEAD traffic low during extended Frigate outages.
    """
    if not settings.frigate_vod_enabled:
        return None
    now = _time.time()
    cached = _hls_reachable_cache.get(camera)
    if cached is not None:
        reachable, ts, fail_count = cached
        ttl = _HLS_CACHE_TTL_SEC if reachable else min(2 * (2 ** fail_count), 60)
        if ts + ttl > now:
            return _build_hls_url(camera, requested_ts, seg_start) if reachable else None
    url = _build_hls_url(camera, requested_ts, seg_start)
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.head(url)
            if r.status_code < 300:
                _hls_reachable_cache[camera] = (True, now, 0)
                return url
    except Exception:
        pass
    # Negative result: increment fail_count from prior negative entry, or start at 0
    prior = _hls_reachable_cache.get(camera)
    fail_count = (prior[2] + 1) if prior is not None and not prior[0] else 0
    _hls_reachable_cache[camera] = (False, now, fail_count)
    return None
