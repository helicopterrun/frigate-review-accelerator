import type { SemanticEntity } from "@frigate-review/shared-types";
import { fetchEvents, fetchReviews } from "../adapters/frigate-http-client.js";
import { normalizeFrigateEvent, attachReviewToEntity } from "../adapters/frigate-entity-normalizer.js";
import { SemanticIndex } from "../semantic/semantic-index.js";

export async function backfillRange(
  index: SemanticIndex,
  cameras: string[],
  startTime: number,
  endTime: number,
): Promise<{ eventsLoaded: number; reviewsLoaded: number }> {
  let eventsLoaded = 0;
  let reviewsLoaded = 0;

  // Fetch events for each camera (Frigate API filters by single camera)
  for (const camera of cameras) {
    try {
      const rawEvents = await fetchEvents({
        cameras: [camera],
        after: startTime,
        before: endTime,
        hasSnapshot: true,
        limit: 500,
      });

      for (const raw of rawEvents) {
        const entity = normalizeFrigateEvent(raw);
        index.upsert(entity);
        eventsLoaded++;
      }
    } catch (err) {
      console.warn(`[backfill] Failed to fetch events for ${camera}:`, err);
    }
  }

  // Fetch reviews and attach to entities
  for (const camera of cameras) {
    try {
      const reviews = await fetchReviews({
        camera,
        after: startTime,
        before: endTime,
        limit: 200,
      });

      for (const review of reviews) {
        reviewsLoaded++;
        for (const detectionId of review.data.detections) {
          const entity = index.get(detectionId);
          if (entity) {
            const updated = attachReviewToEntity(entity, review);
            index.upsert(updated);
          }
        }
      }
    } catch (err) {
      console.warn(`[backfill] Failed to fetch reviews for ${camera}:`, err);
    }
  }

  return { eventsLoaded, reviewsLoaded };
}

/**
 * Backfill with margin: fetch 25% extra on each side of the visible range.
 */
export async function backfillViewportRange(
  index: SemanticIndex,
  cameras: string[],
  tViewStart: number,
  tViewEnd: number,
  tWheel: number,
): Promise<{ eventsLoaded: number; reviewsLoaded: number }> {
  const margin = tWheel * 0.25;
  return backfillRange(index, cameras, tViewStart - margin, tViewEnd + margin);
}
