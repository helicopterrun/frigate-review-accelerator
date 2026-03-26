import type { TimelineSlot, TimelineViewport, SlotResolvedEvent } from "@frigate-review/shared-types";
import { extractFrame } from "../services/media-client.js";
import { SlotCache } from "./slot-cache.js";

export async function resolveTypeASlot(
  viewport: TimelineViewport,
  slot: TimelineSlot,
  cache: SlotCache,
): Promise<SlotResolvedEvent> {
  // Check cache first
  const cached = cache.get(slot.index, "A");
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const camera = viewport.cameraIds[0];
  const timestamp = slot.tSlotCenter;

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

    cache.put(resolved);
    return resolved;
  } catch (err) {
    // Return a placeholder on failure — don't block the pipeline
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

  // Process in batches to avoid overwhelming the media service
  for (let i = 0; i < slots.length; i += concurrency) {
    const batch = slots.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((slot) => resolveTypeASlot(viewport, slot, cache)),
    );
    results.push(...batchResults);
  }

  return results;
}
