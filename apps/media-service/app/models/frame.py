from pydantic import BaseModel
from typing import Optional, Literal, List


class FrameExtractRequest(BaseModel):
    camera: str
    timestamp: float
    mode: Literal["fast", "accurate"] = "fast"
    format: Literal["jpg", "webp"] = "jpg"
    width: Optional[int] = 320
    height: Optional[int] = None


class FrameExtractResponse(BaseModel):
    ok: bool
    cache_hit: bool
    media_url: str
    source: str
    requested_timestamp: float
    resolved_timestamp: float


class BatchFrameExtractRequest(BaseModel):
    camera: str
    timestamps: List[float]
    mode: Literal["fast", "accurate"] = "fast"
    format: Literal["jpg", "webp"] = "jpg"
    width: Optional[int] = 320
    height: Optional[int] = None
