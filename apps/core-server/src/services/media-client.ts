import type { FrameExtractRequest, FrameExtractResponse } from "@frigate-review/shared-types";

const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL ?? "http://localhost:4020";

export async function extractFrame(req: FrameExtractRequest): Promise<FrameExtractResponse> {
  const res = await fetch(`${MEDIA_SERVICE_URL}/frame/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    throw new Error(`media-service /frame/extract failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<FrameExtractResponse>;
}

export async function extractFrameBatch(
  camera: string,
  timestamps: number[],
  mode: "fast" | "accurate" = "fast",
): Promise<FrameExtractResponse[]> {
  const res = await fetch(`${MEDIA_SERVICE_URL}/frame/extract_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ camera, timestamps, mode }),
  });

  if (!res.ok) {
    throw new Error(`media-service /frame/extract_batch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { ok: boolean; results: FrameExtractResponse[] };
  return data.results;
}

export async function checkMediaServiceHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${MEDIA_SERVICE_URL}/health`);
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
