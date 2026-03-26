import type { SemanticEntity } from "@frigate-review/shared-types";
import type { FrigateRawEvent, FrigateRawReview } from "./frigate-http-client.js";

export function normalizeFrigateEvent(raw: FrigateRawEvent): SemanticEntity {
  const box = raw.data?.box;
  let area: number | null = null;
  if (box && box.length >= 4) {
    // box is [x, y, width, height] as fractions of frame
    area = box[2] * box[3];
  }

  const speed = raw.data?.average_estimated_speed ?? 0;
  const stationary = speed === 0;

  return {
    id: raw.id,
    camera: raw.camera,
    label: raw.label,
    subLabel: raw.sub_label ?? null,
    startTime: raw.start_time,
    endTime: raw.end_time ?? null,
    score: raw.data?.score ?? null,
    topScore: raw.data?.top_score ?? raw.top_score ?? null,
    area,
    stationary,
    positionChanges: null,
    currentZones: raw.zones ?? [],
    enteredZones: raw.zones ?? [],
    snapshot: {
      available: raw.has_snapshot,
      frameTime: raw.start_time,
      score: raw.data?.score ?? null,
      path: raw.has_snapshot ? `/api/events/${raw.id}/snapshot.jpg` : null,
    },
    review: undefined,
    enrichments: undefined,
    lastUpdated: Date.now() / 1000,
  };
}

export function attachReviewToEntity(
  entity: SemanticEntity,
  review: FrigateRawReview,
): SemanticEntity {
  return {
    ...entity,
    review: {
      reviewId: review.id,
      severity: review.severity as "alert" | "detection" | "info" | null,
      reviewed: review.has_been_reviewed,
    },
    lastUpdated: Date.now() / 1000,
  };
}
