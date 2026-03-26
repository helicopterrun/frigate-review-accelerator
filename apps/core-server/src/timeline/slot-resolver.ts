import type {
  TimelineSlot,
  TimelineViewport,
  SlotResolvedEvent,
  TypeBRequest,
} from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { resolveTypeB } from "./type-b-resolver.js";
import { extractFrameBatch } from "../services/media-client.js";
import { SlotCache } from "./slot-cache.js";

const SEMANTIC_THRESHOLD_SEC = 300; // 5 minutes — below this, Type A only

/**
 * Resolve a batch of slots. Type B slots are resolved synchronously from the
 * in-memory index. All Type A slots (including Type B fallbacks) are collected
 * and resolved in a single batch call to the media service — one Frigate clip
 * download, one FFmpeg process for all frames.
 */
export async function resolveSlotBatch(
  viewport: TimelineViewport,
  slots: TimelineSlot[],
  index: SemanticIndex,
  cache: SlotCache,
): Promise<SlotResolvedEvent[]> {
  const camera = viewport.cameraIds[0];
  const results: SlotResolvedEvent[] = [];
  const typeASlots: TimelineSlot[] = [];

  // First pass: resolve Type B from memory, collect Type A needs
  for (const slot of slots) {
    // Check cache
    const cached = cache.getBestForTime(camera, slot.tSlotCenter);
    if (cached) {
      results.push({ ...cached, slotIndex: slot.index, cacheHit: true });
      continue;
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
        results.push(resolved);
        continue;
      }
    }

    // Needs Type A — collect for batch
    typeASlots.push(slot);
  }

  // Second pass: batch extract all Type A frames in one call
  if (typeASlots.length > 0) {
    const timestamps = typeASlots.map((s) => s.tSlotCenter);

    try {
      const batchResults = await extractFrameBatch(camera, timestamps);

      for (let i = 0; i < typeASlots.length; i++) {
        const slot = typeASlots[i];
        const frameResult = batchResults[i];

        if (frameResult) {
          const resolved: SlotResolvedEvent = {
            viewportId: viewport.viewportId,
            slotIndex: slot.index,
            resolvedStrategy: "A",
            mediaUrl: frameResult.media_url,
            sourceTimestamp: frameResult.resolved_timestamp,
            cacheHit: frameResult.cache_hit,
            status: "clean",
          };
          cache.put(camera, slot.tSlotCenter, resolved);
          results.push(resolved);
        } else {
          results.push({
            viewportId: viewport.viewportId,
            slotIndex: slot.index,
            resolvedStrategy: "A",
            mediaUrl: "",
            sourceTimestamp: slot.tSlotCenter,
            cacheHit: false,
            status: "dirty",
          });
        }
      }
    } catch {
      // Batch failed — return empty results for Type A slots
      for (const slot of typeASlots) {
        results.push({
          viewportId: viewport.viewportId,
          slotIndex: slot.index,
          resolvedStrategy: "A",
          mediaUrl: "",
          sourceTimestamp: slot.tSlotCenter,
          cacheHit: false,
          status: "dirty",
        });
      }
    }
  }

  // Sort by slot index for consistent ordering
  results.sort((a, b) => a.slotIndex - b.slotIndex);
  return results;
}
