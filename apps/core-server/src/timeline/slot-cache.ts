import type { SlotResolvedEvent } from "@frigate-review/shared-types";

/**
 * Server-side frame cache keyed by (camera, tSlotCenter, strategy).
 * This survives viewport shifts — if a slot center timestamp was already
 * resolved, we reuse it even at a different slot index.
 */
function timeKey(camera: string, tSlotCenter: number, strategy: string): string {
  // Round to 2 decimal places to avoid floating point key mismatches
  return `${camera}:${tSlotCenter.toFixed(2)}:${strategy}`;
}

export class SlotCache {
  private frames = new Map<string, SlotResolvedEvent>();
  private maxEntries: number;

  constructor(maxEntries = 600) {
    this.maxEntries = maxEntries;
  }

  hasForTime(camera: string, tSlotCenter: number, strategy: string): boolean {
    return this.frames.has(timeKey(camera, tSlotCenter, strategy));
  }

  getForTime(camera: string, tSlotCenter: number, strategy: string): SlotResolvedEvent | undefined {
    return this.frames.get(timeKey(camera, tSlotCenter, strategy));
  }

  getBestForTime(camera: string, tSlotCenter: number): SlotResolvedEvent | undefined {
    return this.getForTime(camera, tSlotCenter, "B") ?? this.getForTime(camera, tSlotCenter, "A");
  }

  put(camera: string, tSlotCenter: number, frame: SlotResolvedEvent): void {
    if (this.frames.size >= this.maxEntries) {
      // Evict oldest entry
      const firstKey = this.frames.keys().next().value;
      if (firstKey !== undefined) this.frames.delete(firstKey);
    }
    this.frames.set(timeKey(camera, tSlotCenter, frame.resolvedStrategy), frame);
  }

  clear(): void {
    this.frames.clear();
  }

  invalidateTypeB(): void {
    for (const key of this.frames.keys()) {
      if (key.endsWith(":B")) {
        this.frames.delete(key);
      }
    }
  }

  /** Invalidate all cached results for a specific (camera, time) pair. */
  invalidateForTime(camera: string, tSlotCenter: number): void {
    this.frames.delete(timeKey(camera, tSlotCenter, "A"));
    this.frames.delete(timeKey(camera, tSlotCenter, "B"));
  }
}
