import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteInstance {
  db: Database.Database;
  dbPath: string;
  status: "ready" | "error";
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

  return { db, dbPath, status: "ready" };
}
