import Fastify from "fastify";
import { registerSocket } from "./realtime/socket.js";
import { bootstrapSqlite } from "./persistence/sqlite.js";
import { checkMediaServiceHealth } from "./services/media-client.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4010);
const dbPath = process.env.SQLITE_PATH ?? "./data/review-accelerator.sqlite";

const sqlite = bootstrapSqlite(dbPath);

app.get("/health", async () => ({
  ok: true,
  service: "core-server",
  sqlite: { dbPath: sqlite.dbPath, status: sqlite.status },
  mediaService: await checkMediaServiceHealth(),
}));

const start = async () => {
  await app.listen({ port, host: "0.0.0.0" });
  registerSocket(app.server);
  app.log.info(`core-server listening on ${port}`);
};

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
