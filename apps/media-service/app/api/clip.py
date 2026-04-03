from fastapi import APIRouter
from app.models.preview import ClipPrepareRequest, ClipPrepareResponse
from app.services.clip_service import prepare_clip

router = APIRouter()


@router.post("/clip/prepare", response_model=ClipPrepareResponse)
async def clip_prepare(req: ClipPrepareRequest) -> ClipPrepareResponse:
    result = await prepare_clip(
        camera=req.camera,
        start_time=req.start_time,
        end_time=req.end_time,
    )
    return ClipPrepareResponse(**result)
