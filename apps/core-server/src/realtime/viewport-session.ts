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
    const prevWheel = this.viewport.tWheel;

    this.viewport = updateViewport(this.viewport, event);
    this.slots = computeSlots(this.viewport);

    // If zoom changed, invalidate cache since slot boundaries changed
    if (this.viewport.tWheel !== prevWheel) {
      this.cache.clear();
    }

    return { slotsChanged: true };
  }

  nextGeneration(): number {
    return ++this.resolveGeneration;
  }

  currentGeneration(): number {
    return this.resolveGeneration;
  }

  /** Get slots that don't have cached Type A results (by time, not index). */
  getUncachedSlots(): TimelineSlot[] {
    const camera = this.viewport.cameraIds[0];
    return this.slots.filter(
      (slot) => !this.cache.hasForTime(camera, slot.tSlotCenter, "A"),
    );
  }
}
