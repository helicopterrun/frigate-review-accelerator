import type { Server as SocketIOServer } from "socket.io";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { resolveSlotBatch } from "../timeline/slot-resolver.js";
import { getActiveSessions } from "./socket.js";

/**
 * Find all active viewport sessions that overlap the given time range
 * for the given camera, mark affected slots dirty, re-resolve them
 * as a batch, and emit updates to clients.
 */
export async function invalidateRangeForAllSessions(
  io: SocketIOServer,
  camera: string,
  startTime: number,
  endTime: number,
  reason: string,
  index: SemanticIndex,
): Promise<void> {
  const activeSessions = getActiveSessions();

  for (const [socketId, viewportSessions] of activeSessions) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    for (const [, session] of viewportSessions) {
      if (!session.viewport.cameraIds.includes(camera)) continue;

      const affectedSlots = session.slots.filter(
        (slot) => slot.tSlotStart < endTime && slot.tSlotEnd > startTime,
      );

      if (affectedSlots.length === 0) continue;

      // Emit dirty notifications
      socket.emit("slots:dirty", {
        viewportId: session.viewport.viewportId,
        slotIndices: affectedSlots.map((s) => s.index),
        reason,
      });

      // Invalidate cache for affected slots
      for (const slot of affectedSlots) {
        session.cache.invalidateForTime(camera, slot.tSlotCenter);
      }

      // Re-resolve affected slots as a batch
      try {
        const reresolved = await resolveSlotBatch(
          session.viewport,
          affectedSlots,
          index,
          session.cache,
        );

        if (reresolved.length > 0) {
          socket.emit("slots:batch_resolved", {
            viewportId: session.viewport.viewportId,
            slots: reresolved,
          });
        }
      } catch {
        // Skip failed batch re-resolution
      }
    }
  }
}
