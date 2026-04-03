import type { TimelineViewport, TimelineSlot } from "@frigate-review/shared-types";

/**
 * Priority levels for slot resolution work.
 * Lower number = higher priority.
 *
 * VISIBLE  — slots currently in the viewport (resolved inline, not queued)
 * DIRTY    — slots invalidated by MQTT events (resolved immediately by slot-invalidator)
 * PREFETCH_FORWARD  — adjacent slots ahead of the viewport (background)
 * PREFETCH_BACKWARD — adjacent slots behind the viewport (background, lowest priority)
 */
export const SlotPriority = {
  VISIBLE: 0,
  DIRTY: 1,
  PREFETCH_FORWARD: 2,
  PREFETCH_BACKWARD: 3,
} as const;

export type SlotPriority = (typeof SlotPriority)[keyof typeof SlotPriority];

export interface ScheduledSlot {
  slot: TimelineSlot;
  priority: SlotPriority;
}

/** Number of slots to prefetch in each direction beyond the viewport. */
const PREFETCH_COUNT = 30;

/**
 * Compute slots adjacent to the current viewport for background prefetch.
 *
 * Returns PREFETCH_FORWARD slots first (nearest to viewport edge first),
 * followed by PREFETCH_BACKWARD slots (nearest to viewport edge first).
 * This ordering ensures the scheduler processes forward slots before backward
 * ones, matching the natural forward-motion scroll pattern.
 */
export function computePrefetchSlots(viewport: TimelineViewport): ScheduledSlot[] {
  const { tViewEnd, tViewStart, tDiv } = viewport;
  const results: ScheduledSlot[] = [];

  // PREFETCH_FORWARD: slots after tViewEnd, nearest first
  for (let i = 0; i < PREFETCH_COUNT; i++) {
    const tSlotStart = tViewEnd + i * tDiv;
    const tSlotEnd = tSlotStart + tDiv;
    results.push({
      slot: {
        index: 60 + i,
        tSlotStart,
        tSlotEnd,
        tSlotCenter: (tSlotStart + tSlotEnd) / 2,
      },
      priority: SlotPriority.PREFETCH_FORWARD,
    });
  }

  // PREFETCH_BACKWARD: slots before tViewStart, nearest first
  for (let i = 0; i < PREFETCH_COUNT; i++) {
    const tSlotEnd = tViewStart - i * tDiv;
    const tSlotStart = tSlotEnd - tDiv;
    results.push({
      slot: {
        index: -1 - i,
        tSlotStart,
        tSlotEnd,
        tSlotCenter: (tSlotStart + tSlotEnd) / 2,
      },
      priority: SlotPriority.PREFETCH_BACKWARD,
    });
  }

  return results;
}
