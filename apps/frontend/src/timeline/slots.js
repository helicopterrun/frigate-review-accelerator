/**
 * Slot generation — deterministic conversion of a viewport into time buckets.
 *
 * Each slot has explicit [tSlotStart, tSlotEnd) bounds derived from tViewStart.
 * No signed-offset arithmetic; slots are generated positionally.
 */

export function buildSlots(viewport) {
  const slots = [];
  for (let i = 0; i < viewport.cSlots; i++) {
    const tSlotStart = viewport.tViewStart + i * viewport.tDivMs;
    const tSlotEnd = tSlotStart + viewport.tDivMs;
    const tSlotCenter = tSlotStart + viewport.tDivMs / 2;
    slots.push({
      index: i,
      tSlotStart,
      tSlotEnd,
      tSlotCenter,
    });
  }
  return slots;
}
