"""Pydantic models for API request/response schemas."""

from pydantic import BaseModel


class SegmentInfo(BaseModel):
    id: int
    camera: str
    start_ts: float
    end_ts: float
    duration: float
    has_previews: bool


class GapInfo(BaseModel):
    """A period with no recording coverage.

    The frontend MUST render these differently from segments —
    gaps are where the camera was offline, disabled, or had no motion
    to trigger recording. Without explicit gap modeling the timeline
    lies to the user by implying continuous coverage.
    """
    start_ts: float
    end_ts: float
    duration: float


class EventInfo(BaseModel):
    id: str
    camera: str
    start_ts: float
    end_ts: float | None
    label: str
    score: float | None


class ActivityBucket(BaseModel):
    """Event density for a time bucket — drives the heatmap layer.

    bucket_ts is the start of the bucket. count is total events.
    labels is a breakdown by detection type.
    """
    bucket_ts: float
    count: int
    labels: dict[str, int]


class TimelineResponse(BaseModel):
    camera: str
    start_ts: float
    end_ts: float
    segments: list[SegmentInfo]
    gaps: list[GapInfo]
    events: list[EventInfo]
    activity: list[ActivityBucket]
    coverage_pct: float  # what % of the time range has recordings


class PreviewFrame(BaseModel):
    ts: float
    url: str  # relative URL to fetch the image


class PreviewStrip(BaseModel):
    """A batch of preview frame URLs for efficient timeline rendering."""
    camera: str
    start_ts: float
    end_ts: float
    interval: float  # seconds between frames
    frames: list[PreviewFrame]


class PlaybackTarget(BaseModel):
    """Everything the frontend needs to start playback at a timestamp.

    The frontend should NOT figure out which segment to play — the backend
    knows the segment index and does this in O(1). This removes a class
    of frontend bugs and race conditions.
    """
    camera: str
    requested_ts: float
    segment_id: int
    segment_start_ts: float
    segment_end_ts: float
    offset_sec: float        # seek position within the segment
    stream_url: str          # ready-to-use <video> src
    next_segment_id: int | None  # for preloading / gapless advance
    hls_url: str | None = None  # Frigate VOD HLS playlist URL (None = Frigate unreachable)


class CameraInfo(BaseModel):
    name: str
    segment_count: int
    preview_count: int
    earliest_ts: float | None
    latest_ts: float | None


class ScanResult(BaseModel):
    camera: str
    new_segments: int
    total_segments: int


class HealthResponse(BaseModel):
    status: str
    cameras: int
    total_segments: int
    total_previews: int
    pending_previews: int
    frigate_reachable: bool


class CameraPreviewStatus(BaseModel):
    camera: str
    total_segments: int
    previews_done: int
    pending_recent: int       # pending within recency window
    pending_historical: int   # pending outside recency window
    pct_recent_complete: float
