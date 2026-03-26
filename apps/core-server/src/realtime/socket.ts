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

      // Resolve all slots via Type A
      await resolveAndEmit(socket, session);
    });

    socket.on("viewport:update", async (payload: ViewportUpdateEvent) => {
      const session = socketSessions.get(payload.viewportId);
      if (!session) return;

      const { slotsChanged } = session.update(payload);
      if (!slotsChanged) return;

      const gen = session.nextGeneration();

      // Resolve only uncached slots
      const uncached = session.getUncachedSlots();
      if (uncached.length === 0) {
        // All cached — emit from cache
        emitAllFromCache(socket, session);
        return;
      }

      const results = await resolveTypeABatch(
        session.viewport,
        uncached,
        session.cache,
        10,
      );

      // Check generation — if viewport moved again, skip this emit
      if (session.currentGeneration() !== gen) return;

      emitAllFromCache(socket, session);
    });

    socket.on("disconnect", () => {
      sessions.delete(socket.id);
    });
  });

  return io;
}

async function resolveAndEmit(socket: any, session: ViewportSession): Promise<void> {
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

function emitAllFromCache(socket: any, session: ViewportSession): void {
  const slots: SlotResolvedEvent[] = [];
  for (const slot of session.slots) {
    const cached = session.cache.getBest(slot.index);
    if (cached) {
      slots.push(cached);
    }
  }

  if (slots.length > 0) {
    socket.emit("slots:batch_resolved", {
      viewportId: session.viewport.viewportId,
      slots,
    });
  }
}
