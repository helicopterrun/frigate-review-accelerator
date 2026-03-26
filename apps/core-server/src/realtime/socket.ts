import { Server as SocketIOServer } from "socket.io";
import type {
  ViewportSubscribeEvent,
  ViewportSubscribedEvent,
  ViewportUpdateEvent,
  SlotResolvedEvent,
} from "@frigate-review/shared-types";
import { ViewportSession } from "./viewport-session.js";
import { resolveSlotBatch } from "../timeline/slot-resolver.js";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { backfillViewportRange } from "../services/http-backfill.js";
import { getMqttStatus } from "../adapters/frigate-mqtt-ingestor.js";

// Global semantic index — shared across all viewport sessions
const semanticIndex = new SemanticIndex();
const sessions = new Map<string, Map<string, ViewportSession>>();

export function getSemanticIndex(): SemanticIndex {
  return semanticIndex;
}

export function getActiveSessions(): Map<string, Map<string, ViewportSession>> {
  return sessions;
}

export function registerSocket(server: any) {
  const io = new SocketIOServer(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    const socketSessions = new Map<string, ViewportSession>();
    sessions.set(socket.id, socketSessions);

    socket.on("viewport:subscribe", async (payload: ViewportSubscribeEvent) => {
      const session = new ViewportSession(payload);
      socketSessions.set(payload.viewportId, session);

      // HTTP backfill for semantic data before resolution
      let freshness: "live" | "recovering" | "stale" = "recovering";
      try {
        const { eventsLoaded, reviewsLoaded } = await backfillViewportRange(
          semanticIndex,
          session.viewport.cameraIds,
          session.viewport.tViewStart,
          session.viewport.tViewEnd,
          session.viewport.tWheel,
        );
        console.log(
          `[socket] Backfilled ${eventsLoaded} events, ${reviewsLoaded} reviews. Index size: ${semanticIndex.size()}`,
        );
        freshness = eventsLoaded > 0 ? "live" : "recovering";
        // Promote to "live" if MQTT is connected even when no events in range
        const mqttState = getMqttStatus();
        if (mqttState.connected && freshness === "recovering") {
          freshness = "live";
        }
      } catch (err) {
        console.warn("[socket] Backfill failed, continuing with Type A:", err);
        freshness = "stale";
      }

      const subscribed: ViewportSubscribedEvent = {
        viewportId: session.viewport.viewportId,
        cameraIds: session.viewport.cameraIds,
        tCursor: session.viewport.tCursor,
        tWheel: session.viewport.tWheel,
        cSlots: session.viewport.cSlots,
        serverTime: Date.now() / 1000,
        playbackState: "SCRUB_REVIEW",
        semanticFreshness: freshness,
      };

      socket.emit("viewport:subscribed", subscribed);

      // Resolve all slots (Type B with A fallback)
      await resolveAndEmitBatch(socket, session);
    });

    socket.on("viewport:update", async (payload: ViewportUpdateEvent) => {
      const session = socketSessions.get(payload.viewportId);
      if (!session) return;

      session.update(payload);
      const gen = session.nextGeneration();

      const camera = session.viewport.cameraIds[0];
      const cachedSlots: SlotResolvedEvent[] = [];
      const uncachedSlots = [];

      for (const slot of session.slots) {
        const cached = session.cache.getBestForTime(camera, slot.tSlotCenter);
        if (cached) {
          cachedSlots.push({ ...cached, slotIndex: slot.index, cacheHit: true });
        } else {
          uncachedSlots.push(slot);
        }
      }

      // Emit cached slots immediately
      if (cachedSlots.length > 0) {
        socket.emit("slots:batch_resolved", {
          viewportId: session.viewport.viewportId,
          slots: cachedSlots,
        });
      }

      if (uncachedSlots.length === 0) return;

      // Resolve uncached slots
      const newResults = await resolveSlotBatch(
        session.viewport,
        uncachedSlots,
        semanticIndex,
        session.cache,
        10,
      );

      if (session.currentGeneration() !== gen) return;

      if (newResults.length > 0) {
        socket.emit("slots:batch_resolved", {
          viewportId: session.viewport.viewportId,
          slots: newResults,
        });
      }
    });

    socket.on("disconnect", () => {
      sessions.delete(socket.id);
    });
  });

  return io;
}

async function resolveAndEmitBatch(socket: any, session: ViewportSession): Promise<void> {
  const gen = session.nextGeneration();

  const results = await resolveSlotBatch(
    session.viewport,
    session.slots,
    semanticIndex,
    session.cache,
    10,
  );

  if (session.currentGeneration() !== gen) return;

  socket.emit("slots:batch_resolved", {
    viewportId: session.viewport.viewportId,
    slots: results,
  });
}
