"""TimeIndex — stateless time-bucketing service.

All methods are pure math or a single stat() call.  No DB access, no async.
This is the single source of truth for bucket arithmetic used by:

  - preview.py (hot path scrub lookup)
  - timeline.py (/api/timeline/buckets endpoint)

Bucket alignment is globally consistent:
  bucket_ts = round(ts / interval) * interval

so two clients scrubbing to the same second always resolve the same filename.
"""

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings


class TimeIndex:
    """Stateless service for time-bucket math."""

    def __init__(self, preview_output_path: Path | None = None, interval: float | None = None):
        self._root = preview_output_path or settings.preview_output_path
        self._interval = interval if interval is not None else float(settings.preview_interval_sec)

    # ------------------------------------------------------------------
    # Core math
    # ------------------------------------------------------------------
    def bucket_ts(self, ts: float) -> float:
        """Snap a timestamp to the nearest globally-aligned preview bucket.

        >>> idx.bucket_ts(1700000003.7)  # interval=2 → 1700000004.0
        """
        interval = self._interval
        return round(ts / interval) * interval

    def bucket_path(self, camera: str, ts: float) -> Path:
        """Build the filesystem path for a bucketed preview frame.

        Structure: {preview_root}/{camera}/{YYYY-MM-DD}/{bucket_ts:.2f}.jpg
        """
        b = self.bucket_ts(ts)
        dt = datetime.fromtimestamp(b, tz=timezone.utc)
        date_dir = dt.strftime("%Y-%m-%d")
        filename = f"{b:.2f}.jpg"
        return self._root / camera / date_dir / filename

    def bucket_exists(self, camera: str, ts: float) -> bool:
        """Return True if the preview file for this timestamp exists on disk.

        Uses a single stat() call — not intended for the hot scrub path;
        safe for timeline/bucket queries.
        """
        return self.bucket_path(camera, ts).exists()

    def adjacent_buckets(self, ts: float) -> list[float]:
        """Return [bucket-interval, bucket, bucket+interval]."""
        b = self.bucket_ts(ts)
        interval = self._interval
        return [b - interval, b, b + interval]

    def buckets_in_range(self, start_ts: float, end_ts: float) -> list[float]:
        """Return all globally-aligned bucket timestamps within [start_ts, end_ts]."""
        interval = self._interval
        first = math.ceil(start_ts / interval) * interval
        result = []
        t = first
        while t <= end_ts:
            result.append(t)
            t += interval
        return result

    # ------------------------------------------------------------------
    # Event density
    # ------------------------------------------------------------------
    def event_density(
        self,
        events: list[Any],
        range_start: float,
        range_end: float,
        bucket_sec: float | None = None,
    ) -> list[dict]:
        """Bucketize events into [{ts, count, labels}] dicts.

        auto-derives bucket_sec from range if not provided (mirrors the
        adaptive logic in _compute_activity):
          ≤1h   → 60s
          ≤4h   → 120s
          ≤12h  → 300s
          ≤24h  → 600s
          >24h  → 1800s
        """
        if bucket_sec is None:
            dur = range_end - range_start
            if dur <= 3600:
                bucket_sec = 60.0
            elif dur <= 14400:
                bucket_sec = 120.0
            elif dur <= 43200:
                bucket_sec = 300.0
            elif dur <= 86400:
                bucket_sec = 600.0
            else:
                bucket_sec = 1800.0

        first_bucket = math.floor(range_start / bucket_sec) * bucket_sec
        buckets: dict[float, dict[str, int]] = {}
        t = first_bucket
        while t < range_end:
            buckets[t] = {}
            t += bucket_sec

        for evt in events:
            # Accept both objects with .start_ts and plain dicts
            evt_ts = evt.start_ts if hasattr(evt, "start_ts") else evt["start_ts"]
            evt_label = evt.label if hasattr(evt, "label") else evt.get("label", "unknown")
            b = math.floor(evt_ts / bucket_sec) * bucket_sec
            if b in buckets:
                buckets[b][evt_label] = buckets[b].get(evt_label, 0) + 1

        return [
            {"ts": ts, "count": sum(labels.values()), "labels": labels}
            for ts, labels in sorted(buckets.items())
        ]

    # ------------------------------------------------------------------
    # Resolution selection
    # ------------------------------------------------------------------
    @staticmethod
    def auto_resolution(range_sec: float) -> int:
        """Select bucket resolution (seconds per bucket) from range duration.

        < 1h    →   10s  (~360 buckets max)
        < 4h    →   30s  (~480 buckets max)
        < 12h   →   60s  (~720 buckets max)
        < 24h   →  120s  (~720 buckets max)
        < 72h   →  300s  (~864 buckets max)
        < 7d    →  600s  (~1008 max; see note)
        >= 7d   → 1200s

        Keeps bucket count within frontend rendering budget (~50–900).
        Note: the < 7d tier can reach ~1008 buckets at exactly 7 days — callers
        that need hard ≤900 should use the >= 7d tier or pass resolution explicitly.
        """
        if range_sec < 3600:
            return 10
        if range_sec < 14400:
            return 30
        if range_sec < 43200:
            return 60
        if range_sec < 86400:
            return 120
        if range_sec < 259200:
            return 300
        if range_sec < 604800:
            return 600
        return 1200

    # ------------------------------------------------------------------
    # Timeline buckets (Phase 4)
    # ------------------------------------------------------------------
    def timeline_buckets(
        self,
        range_start: float,
        range_end: float,
        camera: str,
        events: list[Any],
        resolution: int | None = None,
        preview_ts_set: set[float] | None = None,
    ) -> list[dict]:
        """Return [{ts, has_preview, event_density}] for a time range.

        resolution is the desired number of buckets across the range.
        Defaults to 60 if not provided.  Each bucket is bucket_sec = range/resolution
        seconds wide.

        has_preview is True if a preview exists for any bucket within this logical
        bucket.  Checked against preview_ts_set (DB-backed) when provided;
        falls back to filesystem stat() when None.
        event_density is the count of events whose start_ts falls in this bucket.
        """
        if resolution is None:
            resolution = 60

        range_dur = range_end - range_start
        if range_dur <= 0 or resolution <= 0:
            return []

        bucket_sec = range_dur / resolution

        # Build event density index keyed by bucket index
        density = self.event_density(events, range_start, range_end, bucket_sec=bucket_sec)
        density_map: dict[float, int] = {d["ts"]: d["count"] for d in density}

        # Walk buckets at preview_interval_sec resolution inside each logical bucket
        result = []
        for i in range(resolution):
            b_start = range_start + i * bucket_sec
            b_end = b_start + bucket_sec
            bucket_label_ts = b_start

            # Check if any preview exists in this logical bucket.
            # Use DB-backed set when available; fall back to filesystem stat.
            has_preview = False
            for preview_ts in self.buckets_in_range(b_start, b_end):
                if preview_ts_set is not None:
                    if preview_ts in preview_ts_set:
                        has_preview = True
                        break
                else:
                    if self.bucket_exists(camera, preview_ts):
                        has_preview = True
                        break

            evt_count = density_map.get(
                math.floor(b_start / bucket_sec) * bucket_sec, 0
            )
            result.append({
                "ts": bucket_label_ts,
                "has_preview": has_preview,
                "event_density": evt_count,
            })

        return result


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
_time_index: TimeIndex | None = None


def get_time_index() -> TimeIndex:
    """Return the module-level TimeIndex singleton."""
    global _time_index
    if _time_index is None:
        _time_index = TimeIndex()
    return _time_index
