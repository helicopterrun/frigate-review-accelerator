import type {
  TimelineSlot,
  TimelineViewport,
  ViewportSubscribeEvent,
  ViewportUpdateEvent,
} from "@frigate-review/shared-types";

export function buildViewport(input: ViewportSubscribeEvent): TimelineViewport {
  const tDiv = input.tWheel / input.cSlots;
  const tViewStart = input.tCursor - input.tWheel / 2;
  const tViewEnd = input.tCursor + input.tWheel / 2;

  return {
    viewportId: input.viewportId,
    cameraIds: input.cameraIds,
    tCursor: input.tCursor,
    tWheel: input.tWheel,
    cSlots: input.cSlots,
    tDiv,
    tViewStart,
    tViewEnd,
    filters: input.filters ?? { objectLabels: [], zones: [], confidenceMin: 0 },
  };
}

export function updateViewport(
  existing: TimelineViewport,
  update: ViewportUpdateEvent,
): TimelineViewport {
  const tDiv = update.tWheel / existing.cSlots;
  const tViewStart = update.tCursor - update.tWheel / 2;
  const tViewEnd = update.tCursor + update.tWheel / 2;

  return {
    ...existing,
    tCursor: update.tCursor,
    tWheel: update.tWheel,
    tDiv,
    tViewStart,
    tViewEnd,
  };
}

export function computeSlots(viewport: TimelineViewport): TimelineSlot[] {
  return Array.from({ length: viewport.cSlots }, (_, index) => {
    const tSlotStart = viewport.tViewStart + index * viewport.tDiv;
    const tSlotEnd = tSlotStart + viewport.tDiv;
    const tSlotCenter = (tSlotStart + tSlotEnd) / 2;
    return { index, tSlotStart, tSlotEnd, tSlotCenter };
  });
}
