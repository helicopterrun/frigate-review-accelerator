import { Server as SocketIOServer } from "socket.io";
import type {
  ViewportSubscribeEvent,
  ViewportSubscribedEvent,
  ViewportUpdateEvent,
  SlotResolvedEvent,
} from "@frigate-review/shared-types";
import { ViewportSession } from "./viewport-session.js";
import { resolveTypeABatch } from "../timeline/type-a-resolver.js";

const sessions = new Map<string, Map<string, ViewportSession>>();

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

      const subscribed: ViewportSubscribedEvent = {
        viewportId: session.viewport.viewportId,
        cameraIds: session.viewport.cameraIds,
        tCursor: session.viewport.tCursor,
        tWheel: session.viewport.tWheel,
        cSlots: session.viewport.cSlots,
        serverTime: Date.now() / 1000,
        playbackState: "SCRUB_REVIEW",
        semanticFreshness: "recovering",
      };

      socket.emit("viewport:subscribed", subscribed);

      // Full resolve on subscribe
      await resolveAndEmitBatch(socket, session);
    });

    socket.on("viewport:update", async (payload: ViewportUpdateEvent) => {
      const session = socketSessions.get(payload.viewportId);
      if (!session) return;

      session.update(payload);
      const gen = session.nextGeneration();

      // Build the full slot array — use cache hits where possible
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

      // If everything is cached, emit immediately
      if (uncachedSlots.length === 0) {
        socket.emit("slots:batch_resolved", {
          viewportId: session.viewport.viewportId,
          slots: cachedSlots,
        });
        return;
      }

      // Emit cached slots first so the UI updates immediately
      if (cachedSlots.length > 0) {
        socket.emit("slots:batch_resolved", {
          viewportId: session.viewport.viewportId,
          slots: cachedSlots,
        });
      }

      // Resolve uncached slots
      const newResults = await resolveTypeABatch(
        session.viewport,
        uncachedSlots,
        session.cache,
        10,
      );

      // Check generation — skip if viewport moved again
      if (session.currentGeneration() !== gen) return;

      // Emit newly resolved slots incrementally
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

  const results = await resolveTypeABatch(
    session.viewport,
    session.slots,
    session.cache,
    10,
  );

  if (session.currentGeneration() !== gen) return;

  socket.emit("slots:batch_resolved", {
    viewportId: session.viewport.viewportId,
    slots: results,
  });
}
