import type { TimelineSlot, TimelineViewport, SlotResolvedEvent } from "@frigate-review/shared-types";
import { extractFrame } from "../services/media-client.js";
import { SlotCache } from "./slot-cache.js";

export async function resolveTypeASlot(
  viewport: TimelineViewport,
  slot: TimelineSlot,
  cache: SlotCache,
): Promise<SlotResolvedEvent> {
  const camera = viewport.cameraIds[0];
  const timestamp = slot.tSlotCenter;

  // Check cache by time
  const cached = cache.getBestForTime(camera, timestamp);
  if (cached) {
    return { ...cached, slotIndex: slot.index, cacheHit: true };
  }

  try {
    const result = await extractFrame({
      camera,
      timestamp,
      mode: "fast",
      format: "jpg",
      width: 320,
    });

    const resolved: SlotResolvedEvent = {
      viewportId: viewport.viewportId,
      slotIndex: slot.index,
      resolvedStrategy: "A",
      mediaUrl: result.media_url,
      sourceTimestamp: result.resolved_timestamp,
      cacheHit: result.cache_hit,
      status: "clean",
    };

    cache.put(camera, timestamp, resolved);
    return resolved;
  } catch {
    return {
      viewportId: viewport.viewportId,
      slotIndex: slot.index,
      resolvedStrategy: "A",
      mediaUrl: "",
      sourceTimestamp: timestamp,
      cacheHit: false,
      status: "dirty",
    };
  }
}

export async function resolveTypeABatch(
  viewport: TimelineViewport,
  slots: TimelineSlot[],
  cache: SlotCache,
  concurrency = 10,
): Promise<SlotResolvedEvent[]> {
  const results: SlotResolvedEvent[] = [];

  for (let i = 0; i < slots.length; i += concurrency) {
    const batch = slots.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((slot) => resolveTypeASlot(viewport, slot, cache)),
    );
    results.push(...batchResults);
  }

  return results;
}
