import type {
  TimelineSlot,
  TimelineViewport,
  SlotResolvedEvent,
  TypeBRequest,
} from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { resolveTypeB } from "./type-b-resolver.js";
import { extractFrame } from "../services/media-client.js";
import { SlotCache } from "./slot-cache.js";

const SEMANTIC_THRESHOLD_SEC = 300; // 5 minutes — below this, Type A only

export async function resolveSlot(
  viewport: TimelineViewport,
  slot: TimelineSlot,
  index: SemanticIndex,
  cache: SlotCache,
): Promise<SlotResolvedEvent> {
  const camera = viewport.cameraIds[0];

  // Check cache first
  const cached = cache.getBestForTime(camera, slot.tSlotCenter);
  if (cached) {
    return { ...cached, slotIndex: slot.index, cacheHit: true };
  }

  // Try Type B if zoom is wide enough
  if (viewport.tWheel >= SEMANTIC_THRESHOLD_SEC) {
    const typeBReq: TypeBRequest = {
      cameraFilter: viewport.cameraIds,
      objectFilter: viewport.filters.objectLabels,
      zoneFilter: viewport.filters.zones,
      confidenceMin: viewport.filters.confidenceMin,
      includeStationary: true,
      slotStart: slot.tSlotStart,
      slotEnd: slot.tSlotEnd,
      slotCenter: slot.tSlotCenter,
    };

    const typeBResult = resolveTypeB(index, typeBReq);

    if (typeBResult.ok && typeBResult.mediaRef) {
      const resolved: SlotResolvedEvent = {
        viewportId: viewport.viewportId,
        slotIndex: slot.index,
        resolvedStrategy: "B",
        mediaUrl: typeBResult.mediaRef,
        sourceTimestamp: typeBResult.snapshotTime ?? slot.tSlotCenter,
        winnerEntityId: typeBResult.eventId,
        score: typeBResult.score,
        label: typeBResult.label,
        cacheHit: false,
        status: "clean",
      };
      cache.put(camera, slot.tSlotCenter, resolved);
      return resolved;
    }
  }

  // Fall back to Type A
  try {
    const result = await extractFrame({
      camera,
      timestamp: slot.tSlotCenter,
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
    cache.put(camera, slot.tSlotCenter, resolved);
    return resolved;
  } catch {
    return {
      viewportId: viewport.viewportId,
      slotIndex: slot.index,
      resolvedStrategy: "A",
      mediaUrl: "",
      sourceTimestamp: slot.tSlotCenter,
      cacheHit: false,
      status: "dirty",
    };
  }
}

export async function resolveSlotBatch(
  viewport: TimelineViewport,
  slots: TimelineSlot[],
  index: SemanticIndex,
  cache: SlotCache,
  concurrency = 10,
): Promise<SlotResolvedEvent[]> {
  const results: SlotResolvedEvent[] = [];

  for (let i = 0; i < slots.length; i += concurrency) {
    const batch = slots.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((slot) => resolveSlot(viewport, slot, index, cache)),
    );
    results.push(...batchResults);
  }

  return results;
}
