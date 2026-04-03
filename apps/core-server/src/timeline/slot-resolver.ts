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
const PROGRESSIVE_CHUNK_SIZE = 15;  // Type A slots per HTTP call to media-service

/**
 * Resolve slots progressively, calling onChunk as results become available.
 *
 * Emission order:
 *   1. Cache hits + Type B results (synchronous — emitted immediately)
 *   2. Type A frames in center-outward chunks of PROGRESSIVE_CHUNK_SIZE,
 *      sequentially so the media-service semaphore is not overloaded
 *
 * This gives the user visible frames within ~1.3 s rather than waiting ~5 s
 * for all 60 slots to complete.
 */
export async function resolveSlotBatchProgressive(
  viewport: TimelineViewport,
  slots: TimelineSlot[],
  index: SemanticIndex,
  cache: SlotCache,
  onChunk: (slots: SlotResolvedEvent[]) => void,
): Promise<void> {
  const camera = viewport.cameraIds[0];
  const immediateResults: SlotResolvedEvent[] = [];
  const typeASlots: TimelineSlot[] = [];

  for (const slot of slots) {
    const cached = cache.getBestForTime(camera, slot.tSlotCenter);
    if (cached) {
      immediateResults.push({ ...cached, slotIndex: slot.index, cacheHit: true });
      continue;
    }

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
        immediateResults.push(resolved);
        continue;
      }
    }

    typeASlots.push(slot);
  }

  // Emit cache hits + Type B immediately (no I/O required)
  if (immediateResults.length > 0) {
    onChunk(immediateResults);
  }

  if (typeASlots.length === 0) return;

  // Order Type A slots center-outward so visible center slots arrive first
  const minIdx = Math.min(...typeASlots.map((s) => s.index));
  const maxIdx = Math.max(...typeASlots.map((s) => s.index));
  const centerIdx = (minIdx + maxIdx) / 2;
  typeASlots.sort((a, b) => Math.abs(a.index - centerIdx) - Math.abs(b.index - centerIdx));

  // Process in sequential chunks — each chunk runs with the media-service's
  // own concurrency limit, keeping CPU usage bounded
  for (let i = 0; i < typeASlots.length; i += PROGRESSIVE_CHUNK_SIZE) {
    const chunk = typeASlots.slice(i, i + PROGRESSIVE_CHUNK_SIZE);
    const chunkResults = await _resolveTypeAChunk(viewport, camera, chunk, cache);
    onChunk(chunkResults);
  }
}

async function _resolveTypeAChunk(
  viewport: TimelineViewport,
  camera: string,
  chunk: TimelineSlot[],
  cache: SlotCache,
): Promise<SlotResolvedEvent[]> {
  const timestamps = chunk.map((s) => s.tSlotCenter);
  const results: SlotResolvedEvent[] = [];

  try {
    const batchResults = await extractFrameBatch(camera, timestamps);

    for (let i = 0; i < chunk.length; i++) {
      const slot = chunk[i];
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
    for (const slot of chunk) {
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

  return results;
}

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
