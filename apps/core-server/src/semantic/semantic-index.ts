import type { SemanticEntity, EventId, CameraName } from "@frigate-review/shared-types";

const BUCKET_SIZE_SEC = 60; // 60-second time buckets


function overlaps(
  entityStart: number,
  entityEnd: number | null | undefined,
  slotStart: number,
  slotEnd: number,
): boolean {
  const effectiveEnd = entityEnd ?? Number.POSITIVE_INFINITY;
  return entityStart < slotEnd && effectiveEnd > slotStart;
}

export class SemanticIndex {
  readonly byId = new Map<EventId, SemanticEntity>();
  readonly byCamera = new Map<CameraName, Set<EventId>>();
  readonly byLabel = new Map<string, Set<EventId>>();
  readonly byZone = new Map<string, Set<EventId>>();
  readonly byTimeBucket = new Map<string, Set<EventId>>();

  upsert(entity: SemanticEntity): void {
    const existing = this.byId.get(entity.id);
    if (existing) {
      this.removeFromIndices(existing);
    }
    this.byId.set(entity.id, entity);
    this.addToIndices(entity);
  }

  hydrate(entities: SemanticEntity[]): void {
    for (const entity of entities) {
      this.upsert(entity);
    }
  }

  get(id: EventId): SemanticEntity | undefined {
    return this.byId.get(id);
  }

  size(): number {
    return this.byId.size;
  }

  queryRange(params: {
    cameras: string[];
    startTime: number;
    endTime: number;
    labels?: string[];
    zones?: string[];
    confidenceMin?: number;
  }): SemanticEntity[] {
    // Start with time-bucket candidates for coarse pruning
    const candidateIds = this.getCandidatesByTimeBuckets(params.startTime, params.endTime);

    // Filter by camera
    const cameraSet = new Set(params.cameras);
    const results: SemanticEntity[] = [];

    for (const id of candidateIds) {
      const entity = this.byId.get(id);
      if (!entity) continue;

      // Camera filter
      if (!cameraSet.has(entity.camera)) continue;

      // Time overlap check (precise)
      if (!overlaps(entity.startTime, entity.endTime, params.startTime, params.endTime)) continue;

      // Label filter
      if (params.labels && params.labels.length > 0) {
        if (!params.labels.includes(entity.label)) continue;
      }

      // Zone filter
      if (params.zones && params.zones.length > 0) {
        const entityZones = new Set([...entity.currentZones, ...entity.enteredZones]);
        if (!params.zones.some((z) => entityZones.has(z))) continue;
      }

      // Confidence filter
      if (params.confidenceMin != null) {
        const conf = entity.score ?? entity.topScore ?? 0;
        if (conf < params.confidenceMin) continue;
      }

      results.push(entity);
    }

    return results;
  }

  private getCandidatesByTimeBuckets(startTime: number, endTime: number): Set<EventId> {
    const candidates = new Set<EventId>();
    const startBucket = Math.floor(startTime / BUCKET_SIZE_SEC);
    const endBucket = Math.floor(endTime / BUCKET_SIZE_SEC);

    // Include a margin of 1 bucket on each side for entities that span buckets
    for (let b = startBucket - 1; b <= endBucket + 1; b++) {
      const bucket = this.byTimeBucket.get(String(b));
      if (bucket) {
        for (const id of bucket) {
          candidates.add(id);
        }
      }
    }

    return candidates;
  }

  private addToIndices(entity: SemanticEntity): void {
    // Camera index
    if (!this.byCamera.has(entity.camera)) {
      this.byCamera.set(entity.camera, new Set());
    }
    this.byCamera.get(entity.camera)!.add(entity.id);

    // Label index
    if (!this.byLabel.has(entity.label)) {
      this.byLabel.set(entity.label, new Set());
    }
    this.byLabel.get(entity.label)!.add(entity.id);

    // Zone index
    for (const zone of [...entity.currentZones, ...entity.enteredZones]) {
      if (!this.byZone.has(zone)) {
        this.byZone.set(zone, new Set());
      }
      this.byZone.get(zone)!.add(entity.id);
    }

    // Index every bucket the entity is active in so long-running entities (e.g. a car
    // present for hours) remain candidates for queries anywhere in their lifetime.
    // Ongoing entities (endTime = null) are indexed only at their start bucket — they
    // are still active so queries near "now" will find them via the ±1 margin.
    const startBucket = Math.floor(entity.startTime / BUCKET_SIZE_SEC);
    const endBucket =
      entity.endTime != null
        ? Math.floor(entity.endTime / BUCKET_SIZE_SEC)
        : startBucket;
    for (let b = startBucket; b <= endBucket; b++) {
      const key = String(b);
      if (!this.byTimeBucket.has(key)) {
        this.byTimeBucket.set(key, new Set());
      }
      this.byTimeBucket.get(key)!.add(entity.id);
    }
  }

  private removeFromIndices(entity: SemanticEntity): void {
    this.byCamera.get(entity.camera)?.delete(entity.id);
    this.byLabel.get(entity.label)?.delete(entity.id);

    for (const zone of [...entity.currentZones, ...entity.enteredZones]) {
      this.byZone.get(zone)?.delete(entity.id);
    }

    const startBucket = Math.floor(entity.startTime / BUCKET_SIZE_SEC);
    const endBucket =
      entity.endTime != null
        ? Math.floor(entity.endTime / BUCKET_SIZE_SEC)
        : startBucket;
    for (let b = startBucket; b <= endBucket; b++) {
      this.byTimeBucket.get(String(b))?.delete(entity.id);
    }
  }
}
