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
    # Density bucketing
    # ------------------------------------------------------------------
    def compute_density_buckets(
        self,
        events,
        range_start: float,
        range_end: float,
        bucket_sec: int,
        importance_fn=None,
    ) -> list[dict]:
        """Bucket tracked objects with overlap-aware counting.

        A tracked object spanning buckets A through C is counted in A, B, AND C.
        This gives an accurate density reading for the canvas gradient, unlike
        start_ts-only bucketing which under-reports long-lived objects.

        events: iterable of DB rows (start_ts, end_ts, label, ...) or dicts
                with the same keys.
        importance_fn: callable(event_dict) -> bool
            If None, uses label-based default from settings.important_labels.
            Phase 2 will pass a zone-aware predicate here — the density endpoint
            stays unchanged; only the predicate changes.

        Returns list[dict] matching DensityBucket shape:
          {ts, counts, total, important}
        """
        # TODO: Phase 2 — pass a zone-aware predicate from the router so that
        # importance is determined by label + zone membership, not label alone.
        # Example predicate:
        #   def zone_importance(evt):
        #       return (
        #           evt["label"] == "person"
        #           and "front_yard" in json.loads(evt.get("zones", "[]"))
        #       ) or evt["label"] in {"cat", "bird", "bear", "horse"}
        # The important_labels config must stay in sync with any hardcoded
        # frontend Phase 1 label list (see App.jsx isImportant).
        if importance_fn is None:
            important_set = set(settings.important_labels)
            importance_fn = lambda evt: evt.get("label") in important_set  # noqa: E731

        n_buckets = max(1, math.ceil((range_end - range_start) / bucket_sec))
        result = []

        for i in range(n_buckets):
            b_start = range_start + i * bucket_sec
            b_end = b_start + bucket_sec
            counts: dict[str, int] = {}
            important = False

            for evt in events:
                if isinstance(evt, dict):
                    evt_start = evt["start_ts"]
                    evt_end = evt.get("end_ts")
                    evt_label = evt["label"]
                    evt_dict = evt
                else:
                    # DB row: (start_ts, end_ts, label, ...)
                    evt_start = evt[0]
                    evt_end = evt[1]
                    evt_label = evt[2]
                    evt_dict = {"start_ts": evt[0], "end_ts": evt[1], "label": evt[2]}

                if evt_end is None:
                    evt_end = evt_start + 5  # active event fallback

                # Overlap check: event spans this bucket
                if evt_start < b_end and evt_end > b_start:
                    counts[evt_label] = counts.get(evt_label, 0) + 1
                    if not important and importance_fn(evt_dict):
                        important = True

            result.append({
                "ts": b_start,
                "counts": counts,
                "total": sum(counts.values()),
                "important": important,
            })

        return result

    # ------------------------------------------------------------------
    # Resolution selection
    # ------------------------------------------------------------------
    @staticmethod
    def auto_resolution(range_sec: float) -> int:
        """Select bucket resolution (seconds per bucket) from range duration.

        Updated for timeline redesign — aligned with tracked object
        durations (min 5s) and rendering budget (~2000 buckets max for
        the density-only endpoint).

        ≤30m  →  5s  (max  360 buckets)
        ≤1h   →  5s  (max  720 buckets)
        ≤8h   → 15s  (max 1920 buckets)
        >8h   → 60s  (max 1440 buckets at 24h)

        Keep in sync with bucketSizeForRange() in frontend/src/utils/time.js.
        """
        if range_sec <= 1800:
            return 5
        if range_sec <= 3600:
            return 5
        if range_sec <= 28800:
            return 15
        return 60

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

        # Precompute event spans once.  Inline counting below uses b_start/b_end
        # boundaries directly, so density keys are always aligned to the logical
        # bucket series rather than the global floor(ts/bucket_sec) grid.
        evt_spans: list[tuple[float, float]] = []
        for evt in events:
            if hasattr(evt, "start_ts"):
                ts = evt.start_ts
                te = getattr(evt, "end_ts", None)
            else:
                ts = evt["start_ts"]
                te = evt.get("end_ts")
            if te is None:
                te = ts + 30
            evt_spans.append((ts, te))

        # Walk buckets at preview_interval_sec resolution inside each logical bucket
        result = []
        for i in range(resolution):
            b_start = range_start + i * bucket_sec
            b_end = b_start + bucket_sec

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

            evt_count = sum(1 for ts, te in evt_spans if ts < b_end and te > b_start)
            result.append({
                "ts": b_start,
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
