import type { SemanticEntity, TypeBRequest, TypeBResult } from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { getMediaServiceSnapshotUrl } from "../adapters/frigate-http-client.js";

const TYPE_B_THRESHOLD = 0.35;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normalizeArea(area: number | null | undefined): number {
  if (area == null || area <= 0) return 0;
  // Area is a fraction of frame (width * height as fractions)
  // Normalize: ~0.01 is small, ~0.25 is large
  return clamp01(Math.sqrt(area) * 2);
}

function zoneMatchScore(entity: SemanticEntity, zoneFilter?: string[]): number {
  if (!zoneFilter || zoneFilter.length === 0) return 0.5; // neutral when no filter
  const allZones = new Set([...entity.currentZones, ...entity.enteredZones]);
  return zoneFilter.some((z) => allZones.has(z)) ? 1.0 : 0.0;
}

function labelMatchScore(entity: SemanticEntity, objectFilter?: string[]): number {
  if (!objectFilter || objectFilter.length === 0) return 0.5; // neutral when no filter
  return objectFilter.includes(entity.label) ? 1.0 : 0.0;
}

function enrichmentBonus(entity: SemanticEntity): number {
  if (!entity.enrichments) return 0;
  let bonus = 0;
  if (entity.enrichments.face) bonus += 0.4;
  if (entity.enrichments.licensePlate) bonus += 0.3;
  if (entity.enrichments.classification) bonus += 0.2;
  if (entity.enrichments.description) bonus += 0.1;
  return clamp01(bonus);
}

function timeCenterProximity(entity: SemanticEntity, slotCenter: number): number {
  const entityMid = entity.endTime
    ? (entity.startTime + entity.endTime) / 2
    : entity.startTime;
  const distance = Math.abs(entityMid - slotCenter);
  // Normalize: within 30s is close, beyond 300s is far
  return clamp01(1 - distance / 300);
}

function reviewBonus(severity?: string | null): number {
  if (!severity) return 0;
  if (severity === "alert") return 1.0;
  if (severity === "detection") return 0.4;
  return 0.1;
}

export function computeTypeBScore(entity: SemanticEntity, req: TypeBRequest): number {
  const snapshotScore = clamp01(entity.snapshot?.score ?? entity.score ?? 0);
  const topScore = clamp01(entity.topScore ?? entity.score ?? 0);
  const areaScore = normalizeArea(entity.area);
  const zoneScore = zoneMatchScore(entity, req.zoneFilter);
  const labelScore = labelMatchScore(entity, req.objectFilter);
  const motionScore = entity.stationary ? 0.15 : 1.0;
  const enrichScore = enrichmentBonus(entity);
  const centerScore = timeCenterProximity(entity, req.slotCenter);
  const revScore = reviewBonus(entity.review?.severity);

  return (
    0.24 * snapshotScore +
    0.18 * topScore +
    0.14 * areaScore +
    0.12 * zoneScore +
    0.10 * labelScore +
    0.08 * motionScore +
    0.06 * enrichScore +
    0.05 * centerScore +
    0.03 * revScore
  );
}

export function resolveTypeB(
  index: SemanticIndex,
  req: TypeBRequest,
): TypeBResult {
  const candidates = index.queryRange({
    cameras: req.cameraFilter,
    startTime: req.slotStart,
    endTime: req.slotEnd,
    labels: req.objectFilter,
    zones: req.zoneFilter,
    confidenceMin: req.confidenceMin,
  });

  if (candidates.length === 0) {
    return { ok: false, reason: "no_candidates" };
  }

  // Filter usable candidates
  const usable = candidates.filter((c) => {
    if (!req.includeStationary && c.stationary) return false;
    if (!c.snapshot?.available) return false;
    return true;
  });

  if (usable.length === 0) {
    return { ok: false, reason: "no_usable_candidates" };
  }

  // Score and rank
  let bestEntity = usable[0];
  let bestScore = computeTypeBScore(bestEntity, req);

  for (let i = 1; i < usable.length; i++) {
    const score = computeTypeBScore(usable[i], req);
    if (score > bestScore) {
      bestEntity = usable[i];
      bestScore = score;
    }
  }

  if (bestScore < TYPE_B_THRESHOLD) {
    return { ok: false, reason: "below_threshold", score: bestScore };
  }

  return {
    ok: true,
    eventId: bestEntity.id,
    score: bestScore,
    snapshotTime: bestEntity.snapshot?.frameTime ?? bestEntity.startTime,
    mediaRef: getMediaServiceSnapshotUrl(bestEntity.id),
    label: bestEntity.label,
  };
}
