import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteInstance {
  db: Database.Database;
  dbPath: string;
  status: "ready" | "error";
}

let _db: Database.Database | null = null;

/** Returns the initialized DB. Throws if bootstrapSqlite hasn't been called yet. */
export function getDb(): Database.Database {
  if (!_db) throw new Error("SQLite not initialized — call bootstrapSqlite first");
  return _db;
}

const MIGRATIONS = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS media_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera TEXT NOT NULL,
        timestamp REAL NOT NULL,
        mode TEXT NOT NULL DEFAULT 'fast',
        format TEXT NOT NULL DEFAULT 'jpg',
        width INTEGER,
        media_url TEXT NOT NULL,
        source TEXT NOT NULL,
        resolved_timestamp REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(camera, timestamp, mode, format, width)
      );

      CREATE INDEX IF NOT EXISTS idx_media_cache_camera_time
        ON media_cache(camera, timestamp);

      CREATE TABLE IF NOT EXISTS ingest_state (
        source TEXT NOT NULL,
        camera TEXT NOT NULL,
        last_event_time REAL,
        last_backfill_time REAL,
        last_mqtt_message_time REAL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(source, camera)
      );
    `,
  },
  {
    version: 2,
    name: "semantic_entities",
    sql: `
      CREATE TABLE IF NOT EXISTS semantic_entities (
        id TEXT PRIMARY KEY,
        camera TEXT NOT NULL,
        label TEXT NOT NULL,
        sub_label TEXT,
        start_time REAL NOT NULL,
        end_time REAL,
        top_score REAL,
        score REAL,
        area REAL,
        stationary INTEGER,
        position_changes INTEGER,
        current_zones_json TEXT NOT NULL DEFAULT '[]',
        entered_zones_json TEXT NOT NULL DEFAULT '[]',
        attributes_json TEXT,
        snapshot_available INTEGER NOT NULL DEFAULT 0,
        snapshot_frame_time REAL,
        snapshot_score REAL,
        snapshot_path TEXT,
        review_id TEXT,
        review_severity TEXT,
        review_reviewed INTEGER,
        last_updated REAL NOT NULL,
        created_at REAL NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_camera_time
        ON semantic_entities(camera, start_time, end_time);

      CREATE INDEX IF NOT EXISTS idx_semantic_label
        ON semantic_entities(label);

      CREATE TABLE IF NOT EXISTS entity_enrichments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        enrichment_type TEXT NOT NULL,
        value TEXT,
        confidence REAL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES semantic_entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_enrichment_entity
        ON entity_enrichments(entity_id);

      CREATE TABLE IF NOT EXISTS review_items (
        review_id TEXT PRIMARY KEY,
        camera TEXT NOT NULL,
        severity TEXT,
        reviewed INTEGER,
        start_time REAL NOT NULL,
        end_time REAL,
        data_json TEXT,
        last_updated REAL NOT NULL,
        created_at REAL NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_review_camera_time
        ON review_items(camera, start_time);
    `,
  },
  {
    version: 3,
    name: "enrichments_json",
    sql: `
      ALTER TABLE semantic_entities ADD COLUMN enrichments_json TEXT;
    `,
  },
];

export function bootstrapSqlite(dbPath: string): SqliteInstance {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Ensure the migrations table exists before checking versions
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Run migrations
  for (const migration of MIGRATIONS) {
    const applied = db
      .prepare(
        "SELECT version FROM schema_migrations WHERE version = ? LIMIT 1",
      )
      .get(migration.version) as { version: number } | undefined;

    if (!applied) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
      ).run(migration.version, migration.name);
    }
  }

  _db = db;
  return { db, dbPath, status: "ready" };
}
