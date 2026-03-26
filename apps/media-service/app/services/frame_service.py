from app.models.frame import FrameExtractRequest, FrameExtractResponse
from app.services import cache_manager
from app.services.frigate_client import fetch_snapshot
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

        # 2. Try Frigate (unless in mock mode)
        if not MOCK_MODE:
            snapshot_data = await fetch_snapshot(req.camera, req.timestamp)
            if snapshot_data:
                media_url = cache_manager.store_cached(
                    req.camera, req.timestamp, req.mode, req.format, req.width,
                    snapshot_data,
                )
                return FrameExtractResponse(
                    ok=True,
                    cache_hit=False,
                    media_url=media_url,
                    source="frigate_snapshot_api",
                    requested_timestamp=req.timestamp,
                    resolved_timestamp=req.timestamp,
                )

        # 3. Mock mode or Frigate unavailable — generate placeholder
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
