/**
 * Reticle sits at the vertical center of the VerticalTimeline viewport.
 * RETICLE_FRACTION of the range is "future" (above reticle);
 * (1 - RETICLE_FRACTION) is "past" (below reticle).
 * Imported by both App.jsx and VerticalTimeline.jsx — kept here to break
 * the circular App ↔ VerticalTimeline import dependency.
 */
export const RETICLE_FRACTION = 0.5;
