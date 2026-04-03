import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root (works regardless of cwd)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

import Fastify from "fastify";
import { registerSocket, getSemanticIndex } from "./realtime/socket.js";
import { bootstrapSqlite } from "./persistence/sqlite.js";
import { loadEntitiesFromDb } from "./persistence/entity-store.js";
import { checkMediaServiceHealth } from "./services/media-client.js";
import { startMqttIngestor, getMqttStatus } from "./adapters/frigate-mqtt-ingestor.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4010);
const dbPath = process.env.SQLITE_PATH ?? "./data/review-accelerator.sqlite";

const sqlite = bootstrapSqlite(dbPath);

app.get("/health", async () => ({
  ok: true,
  service: "core-server",
  sqlite: { dbPath: sqlite.dbPath, status: sqlite.status },
  mediaService: await checkMediaServiceHealth(),
  mqtt: getMqttStatus(),
}));

const start = async () => {
  await app.listen({ port, host: "0.0.0.0" });
  const io = registerSocket(app.server);

  // Hydrate the semantic index from SQLite before accepting MQTT/socket traffic
  const index = getSemanticIndex();
  try {
    const persisted = loadEntitiesFromDb();
    index.hydrate(persisted);
    app.log.info(`[startup] Hydrated ${persisted.length} entities from SQLite`);
  } catch (err) {
    app.log.warn({ err }, "[startup] Could not hydrate index from SQLite — continuing without");
  }

  // Start MQTT ingestor — connects to Frigate MQTT broker
  startMqttIngestor(index, io);

  app.log.info(`core-server listening on ${port}`);
};

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
