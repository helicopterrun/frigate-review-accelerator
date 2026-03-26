from app.models.frame import FrameExtractRequest, FrameExtractResponse
from app.services import cache_manager
from app.services.ffmpeg_extractor import extract_frame_from_recording
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

        # 2. Extract frame from Frigate recording via FFmpeg (unless mock mode)
        if not MOCK_MODE:
            frame_data = await extract_frame_from_recording(
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

        # 3. Mock mode or extraction failed — generate placeholder
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
