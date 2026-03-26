from app.models.frame import FrameExtractRequest, FrameExtractResponse
from app.services import cache_manager
from app.services.ffmpeg_extractor import extract_frames_batch, extract_single_frame
from app.services.mock_frames import generate_mock_frame
from app.config import MOCK_MODE


class FrameService:
    async def extract_frame(self, req: FrameExtractRequest) -> FrameExtractResponse:
        # 1. Check disk cache
        cached_url = cache_manager.get_cached(
            req.camera, req.timestamp, req.mode, req.format, req.width
        )
        if cached_url:
            return FrameExtractResponse(
                ok=True,
                cache_hit=True,
                media_url=cached_url,
                source="disk_cache",
                requested_timestamp=req.timestamp,
                resolved_timestamp=req.timestamp,
            )

        # 2. Extract from Frigate recording via FFmpeg
        if not MOCK_MODE:
            frame_data = await extract_single_frame(
                req.camera, req.timestamp, req.width or 320, req.format
            )
            if frame_data:
                media_url = cache_manager.store_cached(
                    req.camera, req.timestamp, req.mode, req.format, req.width,
                    frame_data,
                )
                return FrameExtractResponse(
                    ok=True,
                    cache_hit=False,
                    media_url=media_url,
                    source="ffmpeg_recording",
                    requested_timestamp=req.timestamp,
                    resolved_timestamp=req.timestamp,
                )

        # 3. Mock fallback
        mock_data = generate_mock_frame(
            req.camera, req.timestamp, req.width or 320, req.format
        )
        media_url = cache_manager.store_cached(
            req.camera, req.timestamp, req.mode, req.format, req.width,
            mock_data,
        )
        return FrameExtractResponse(
            ok=True,
            cache_hit=False,
            media_url=media_url,
            source="mock" if MOCK_MODE else "mock_fallback",
            requested_timestamp=req.timestamp,
            resolved_timestamp=req.timestamp,
        )

    async def extract_batch(self, camera: str, timestamps: list[float],
                            mode: str = "fast", fmt: str = "jpg",
                            width: int = 320) -> list[FrameExtractResponse]:
        """Extract all frames in one FFmpeg pass from a single Frigate clip."""
        results: list[FrameExtractResponse] = []

        # Check cache first, collect uncached timestamps
        uncached_ts = []
        cached_results: dict[float, FrameExtractResponse] = {}

        for ts in timestamps:
            cached_url = cache_manager.get_cached(camera, ts, mode, fmt, width)
            if cached_url:
                cached_results[ts] = FrameExtractResponse(
                    ok=True, cache_hit=True, media_url=cached_url,
                    source="disk_cache", requested_timestamp=ts, resolved_timestamp=ts,
                )
            else:
                uncached_ts.append(ts)

        # Batch extract uncached frames
        extracted: dict[float, bytes] = {}
        if uncached_ts and not MOCK_MODE:
            extracted = await extract_frames_batch(camera, uncached_ts, width, fmt)

        # Build results in original order
        for ts in timestamps:
            if ts in cached_results:
                results.append(cached_results[ts])
            elif ts in extracted:
                media_url = cache_manager.store_cached(camera, ts, mode, fmt, width, extracted[ts])
                results.append(FrameExtractResponse(
                    ok=True, cache_hit=False, media_url=media_url,
                    source="ffmpeg_recording", requested_timestamp=ts, resolved_timestamp=ts,
                ))
            else:
                # Mock fallback for failed extractions
                mock_data = generate_mock_frame(camera, ts, width, fmt)
                media_url = cache_manager.store_cached(camera, ts, mode, fmt, width, mock_data)
                results.append(FrameExtractResponse(
                    ok=True, cache_hit=False, media_url=media_url,
                    source="mock_fallback", requested_timestamp=ts, resolved_timestamp=ts,
                ))

        return results
