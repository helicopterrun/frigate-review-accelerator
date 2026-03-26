import type { TimelineViewport, TimelineSlot, ViewportSubscribeEvent, ViewportUpdateEvent } from "@frigate-review/shared-types";
import { buildViewport, updateViewport, computeSlots } from "../timeline/viewport.js";
import { SlotCache } from "../timeline/slot-cache.js";

export class ViewportSession {
  viewport: TimelineViewport;
  slots: TimelineSlot[];
  cache: SlotCache;
  private resolveGeneration = 0;

  constructor(event: ViewportSubscribeEvent) {
    this.viewport = buildViewport(event);
    this.slots = computeSlots(this.viewport);
    this.cache = new SlotCache();
  }

  update(event: ViewportUpdateEvent): { slotsChanged: boolean } {
    const prevStart = this.viewport.tViewStart;
    const prevEnd = this.viewport.tViewEnd;
    const prevWheel = this.viewport.tWheel;

    this.viewport = updateViewport(this.viewport, event);
    this.slots = computeSlots(this.viewport);

    // If zoom changed, invalidate cache
    if (this.viewport.tWheel !== prevWheel) {
      this.cache.clear();
      return { slotsChanged: true };
    }

    // If viewport shifted, slots changed
    const slotsChanged =
      this.viewport.tViewStart !== prevStart ||
      this.viewport.tViewEnd !== prevEnd;

    return { slotsChanged };
  }

  /** Returns an incrementing generation number to detect stale resolution results. */
  nextGeneration(): number {
    return ++this.resolveGeneration;
  }

  currentGeneration(): number {
    return this.resolveGeneration;
  }

  /** Get slots that don't have cached Type A results. */
  getUncachedSlots(): TimelineSlot[] {
    return this.slots.filter((slot) => !this.cache.has(slot.index, "A"));
  }
}
