from fastapi import APIRouter
from app.models.preview import PreviewStripRequest, PreviewStripResponse
from app.services.preview_service import build_preview_strip

router = APIRouter()


@router.post("/preview/strip", response_model=PreviewStripResponse)
async def preview_strip(req: PreviewStripRequest) -> PreviewStripResponse:
    result = await build_preview_strip(
        camera=req.camera,
        start_time=req.start_time,
        end_time=req.end_time,
        count=req.count,
    )
    return PreviewStripResponse(**result)
