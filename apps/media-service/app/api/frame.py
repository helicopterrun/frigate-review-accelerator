from fastapi import APIRouter
from app.models.frame import (
    BatchFrameExtractRequest,
    FrameExtractRequest,
    FrameExtractResponse,
)
from app.services.frame_service import FrameService

router = APIRouter(prefix="/frame", tags=["frame"])
service = FrameService()


@router.post("/extract", response_model=FrameExtractResponse)
async def extract_frame(req: FrameExtractRequest):
    return await service.extract_frame(req)


@router.post("/extract_batch")
async def extract_batch(req: BatchFrameExtractRequest):
    results = await service.extract_batch(
        camera=req.camera,
        timestamps=req.timestamps,
        mode=req.mode,
        fmt=req.format,
        width=req.width or 320,
    )
    return {"ok": True, "results": results}
