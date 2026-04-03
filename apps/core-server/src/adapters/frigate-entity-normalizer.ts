import type { SemanticEntity } from "@frigate-review/shared-types";
import type { FrigateRawEvent, FrigateRawReview } from "./frigate-http-client.js";

/**
 * Extract enrichments from a raw Frigate event.
 *
 * Frigate encodes enrichment data in two ways:
 *   - sub_label: face match name (person), vehicle make/model (car), or plate text
 *   - data.attributes: array of detected attribute labels (e.g. "license_plate")
 *
 * Returns undefined when no enrichment data is present.
 */
function extractEnrichments(
  raw: FrigateRawEvent,
): SemanticEntity["enrichments"] {
  const enrichments: NonNullable<SemanticEntity["enrichments"]> = {};

  if (raw.sub_label) {
    if (raw.label === "person") {
      enrichments.face = raw.sub_label;
    } else if (raw.label === "license_plate") {
      enrichments.licensePlate = raw.sub_label;
    } else {
      enrichments.classification = raw.sub_label;
    }
  }

  // Attributes array can contain license_plate detections from LPR
  if (raw.data?.attributes) {
    for (const attr of raw.data.attributes) {
      if (
        (attr.label === "license_plate" || attr.label === "lpr") &&
        !enrichments.licensePlate &&
        raw.sub_label
      ) {
        enrichments.licensePlate = raw.sub_label;
      }
    }
  }

  return Object.keys(enrichments).length > 0 ? enrichments : undefined;
}

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
    enrichments: extractEnrichments(raw),
    lastUpdated: Date.now() / 1000,
  };
}

/**
 * Apply a tracked_object_update enrichment patch to an existing entity.
 * Merges new enrichment data without discarding existing fields.
 */
export function applyEnrichmentUpdate(
  entity: SemanticEntity,
  raw: FrigateRawEvent,
): SemanticEntity {
  const newEnrichments = extractEnrichments(raw);
  if (!newEnrichments) return entity;

  return {
    ...entity,
    subLabel: raw.sub_label ?? entity.subLabel,
    enrichments: { ...entity.enrichments, ...newEnrichments },
    // Also update score/topScore if the tracking update improves them
    score:
      raw.data?.score != null
        ? Math.max(entity.score ?? 0, raw.data.score)
        : entity.score,
    topScore:
      raw.data?.top_score != null
        ? Math.max(entity.topScore ?? 0, raw.data.top_score)
        : entity.topScore,
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
