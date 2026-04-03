import type Database from "better-sqlite3";
import type { SemanticEntity } from "@frigate-review/shared-types";
import { getDb } from "./sqlite.js";

// ── Serialization ────────────────────────────────────────────────────────────

function entityToRow(e: SemanticEntity): Record<string, unknown> {
  return {
    id: e.id,
    camera: e.camera,
    label: e.label,
    sub_label: e.subLabel ?? null,
    start_time: e.startTime,
    end_time: e.endTime ?? null,
    top_score: e.topScore ?? null,
    score: e.score ?? null,
    area: e.area ?? null,
    stationary: e.stationary != null ? (e.stationary ? 1 : 0) : null,
    position_changes: e.positionChanges ?? null,
    current_zones_json: JSON.stringify(e.currentZones),
    entered_zones_json: JSON.stringify(e.enteredZones),
    snapshot_available: e.snapshot?.available ? 1 : 0,
    snapshot_frame_time: e.snapshot?.frameTime ?? null,
    snapshot_score: e.snapshot?.score ?? null,
    snapshot_path: e.snapshot?.path ?? null,
    review_id: e.review?.reviewId ?? null,
    review_severity: e.review?.severity ?? null,
    review_reviewed:
      e.review?.reviewed != null ? (e.review.reviewed ? 1 : 0) : null,
    enrichments_json: e.enrichments ? JSON.stringify(e.enrichments) : null,
    last_updated: e.lastUpdated,
  };
}

function rowToEntity(row: Record<string, unknown>): SemanticEntity {
  const hasReview = row.review_id != null || row.review_severity != null;
  return {
    id: row.id as string,
    camera: row.camera as string,
    label: row.label as string,
    subLabel: (row.sub_label as string | null) ?? null,
    startTime: row.start_time as number,
    endTime: (row.end_time as number | null) ?? null,
    topScore: (row.top_score as number | null) ?? null,
    score: (row.score as number | null) ?? null,
    area: (row.area as number | null) ?? null,
    stationary:
      row.stationary != null ? (row.stationary as number) === 1 : null,
    positionChanges: (row.position_changes as number | null) ?? null,
    currentZones: JSON.parse((row.current_zones_json as string) || "[]"),
    enteredZones: JSON.parse((row.entered_zones_json as string) || "[]"),
    snapshot: {
      available: (row.snapshot_available as number) === 1,
      frameTime: (row.snapshot_frame_time as number | null) ?? null,
      score: (row.snapshot_score as number | null) ?? null,
      path: (row.snapshot_path as string | null) ?? null,
    },
    review: hasReview
      ? {
          reviewId: (row.review_id as string | null) ?? null,
          severity:
            (row.review_severity as
              | "alert"
              | "detection"
              | "info"
              | null) ?? null,
          reviewed:
            row.review_reviewed != null
              ? (row.review_reviewed as number) === 1
              : null,
        }
      : undefined,
    enrichments: row.enrichments_json
      ? JSON.parse(row.enrichments_json as string)
      : undefined,
    lastUpdated: row.last_updated as number,
  };
}

// ── Prepared statement cache ─────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO semantic_entities (
    id, camera, label, sub_label, start_time, end_time,
    top_score, score, area, stationary, position_changes,
    current_zones_json, entered_zones_json,
    snapshot_available, snapshot_frame_time, snapshot_score, snapshot_path,
    review_id, review_severity, review_reviewed, enrichments_json, last_updated
  ) VALUES (
    @id, @camera, @label, @sub_label, @start_time, @end_time,
    @top_score, @score, @area, @stationary, @position_changes,
    @current_zones_json, @entered_zones_json,
    @snapshot_available, @snapshot_frame_time, @snapshot_score, @snapshot_path,
    @review_id, @review_severity, @review_reviewed, @enrichments_json, @last_updated
  )
  ON CONFLICT(id) DO UPDATE SET
    label            = excluded.label,
    sub_label        = excluded.sub_label,
    end_time         = excluded.end_time,
    top_score        = excluded.top_score,
    score            = excluded.score,
    area             = excluded.area,
    stationary       = excluded.stationary,
    position_changes = excluded.position_changes,
    current_zones_json  = excluded.current_zones_json,
    entered_zones_json  = excluded.entered_zones_json,
    snapshot_available  = excluded.snapshot_available,
    snapshot_frame_time = excluded.snapshot_frame_time,
    snapshot_score   = excluded.snapshot_score,
    snapshot_path    = excluded.snapshot_path,
    review_id        = excluded.review_id,
    review_severity  = excluded.review_severity,
    review_reviewed  = excluded.review_reviewed,
    enrichments_json = COALESCE(excluded.enrichments_json, semantic_entities.enrichments_json),
    last_updated     = excluded.last_updated
  WHERE excluded.last_updated >= semantic_entities.last_updated
`;

// Lazily initialized after bootstrapSqlite() runs
let _upsertStmt: Database.Statement | null = null;

function getUpsertStmt(): Database.Statement {
  if (!_upsertStmt) _upsertStmt = getDb().prepare(UPSERT_SQL);
  return _upsertStmt;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Upsert a single entity. Last-write-wins per last_updated. */
export function upsertEntityToDb(entity: SemanticEntity): void {
  getUpsertStmt().run(entityToRow(entity));
}

/**
 * Upsert many entities in a single SQLite transaction.
 * Significantly faster than calling upsertEntityToDb() in a loop.
 */
export function upsertEntitiesBatch(entities: SemanticEntity[]): void {
  if (entities.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(UPSERT_SQL);
  const txn = db.transaction((rows: SemanticEntity[]) => {
    for (const e of rows) stmt.run(entityToRow(e));
  });
  txn(entities);
}

/** Load all persisted entities. Used for index hydration at startup. */
export function loadEntitiesFromDb(): SemanticEntity[] {
  const rows = getDb()
    .prepare("SELECT * FROM semantic_entities ORDER BY start_time ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToEntity);
}

// ── Ingest state ─────────────────────────────────────────────────────────────

export interface IngestStateRecord {
  lastEventTime: number | null;
  lastBackfillTime: number | null;
  lastMqttMessageTime: number | null;
}

/** Returns the checkpoint record for a source+camera pair, or null if none. */
export function getIngestState(
  source: string,
  camera: string,
): IngestStateRecord | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM ingest_state WHERE source = ? AND camera = ? LIMIT 1",
    )
    .get(source, camera) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    lastEventTime: (row.last_event_time as number | null) ?? null,
    lastBackfillTime: (row.last_backfill_time as number | null) ?? null,
    lastMqttMessageTime: (row.last_mqtt_message_time as number | null) ?? null,
  };
}

/** Upsert ingest checkpoint. Only provided fields are written; others preserved. */
export function updateIngestState(
  source: string,
  camera: string,
  fields: Partial<IngestStateRecord>,
): void {
  getDb()
    .prepare(
      `INSERT INTO ingest_state (source, camera, last_event_time, last_backfill_time, last_mqtt_message_time, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(source, camera) DO UPDATE SET
         last_event_time       = COALESCE(excluded.last_event_time,       ingest_state.last_event_time),
         last_backfill_time    = COALESCE(excluded.last_backfill_time,    ingest_state.last_backfill_time),
         last_mqtt_message_time = COALESCE(excluded.last_mqtt_message_time, ingest_state.last_mqtt_message_time),
         updated_at            = datetime('now')`,
    )
    .run(
      source,
      camera,
      fields.lastEventTime ?? null,
      fields.lastBackfillTime ?? null,
      fields.lastMqttMessageTime ?? null,
    );
}

/**
 * Returns all cameras that have an MQTT ingest state record with a known
 * last message time. Used to target gap-fill on reconnect.
 */
export function getMqttTrackedCameras(): Array<{
  camera: string;
  lastMqttMessageTime: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT camera, last_mqtt_message_time
       FROM ingest_state
       WHERE source = 'mqtt' AND last_mqtt_message_time IS NOT NULL`,
    )
    .all() as Array<{ camera: string; last_mqtt_message_time: number }>;

  return rows.map((r) => ({
    camera: r.camera,
    lastMqttMessageTime: r.last_mqtt_message_time,
  }));
}
