from pydantic import BaseModel, field_validator
from typing import Optional


class PreviewStripRequest(BaseModel):
    camera: str
    start_time: float
    end_time: float
    count: int = 12  # number of frames in the strip

    @field_validator("count")
    @classmethod
    def clamp_count(cls, v: int) -> int:
        return max(1, min(v, 60))

    @field_validator("end_time")
    @classmethod
    def end_after_start(cls, v: float, info) -> float:
        start = info.data.get("start_time")
        if start is not None and v <= start:
            raise ValueError("end_time must be after start_time")
        return v


class PreviewStripResponse(BaseModel):
    ok: bool
    url: str
    camera: str
    start_time: float
    end_time: float
    frame_count: int


class ClipPrepareRequest(BaseModel):
    camera: str
    start_time: float
    end_time: float

    @field_validator("end_time")
    @classmethod
    def end_after_start(cls, v: float, info) -> float:
        start = info.data.get("start_time")
        if start is not None and v <= start:
            raise ValueError("end_time must be after start_time")
        return v


class ClipPrepareResponse(BaseModel):
    ok: bool
    clip_url: Optional[str] = None
    status: str  # "ready" | "unavailable"
    source: Optional[str] = None
    duration_sec: Optional[float] = None
    error: Optional[str] = None
