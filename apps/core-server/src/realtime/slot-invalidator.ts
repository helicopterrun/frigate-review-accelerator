import type { Server as SocketIOServer } from "socket.io";
import type { SlotResolvedEvent } from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { resolveSlot } from "../timeline/slot-resolver.js";

// Import the sessions map from socket module
import { getActiveSessions } from "./socket.js";

/**
 * Find all active viewport sessions that overlap the given time range
 * for the given camera, mark affected slots dirty, re-resolve them,
 * and emit updates to clients.
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
      // Check if this viewport watches this camera
      if (!session.viewport.cameraIds.includes(camera)) continue;

      // Find overlapping slots
      const affectedSlots = session.slots.filter(
        (slot) => slot.tSlotStart < endTime && slot.tSlotEnd > startTime,
      );

      if (affectedSlots.length === 0) continue;

      // Emit dirty notifications
      const dirtyIndices = affectedSlots.map((s) => s.index);
      socket.emit("slots:dirty", {
        viewportId: session.viewport.viewportId,
        slotIndices: dirtyIndices,
        reason,
      });

      // Invalidate cache for affected slots and re-resolve
      for (const slot of affectedSlots) {
        session.cache.invalidateForTime(
          camera,
          slot.tSlotCenter,
        );
      }

      // Re-resolve affected slots
      const reresolved: SlotResolvedEvent[] = [];
      for (const slot of affectedSlots) {
        try {
          const result = await resolveSlot(
            session.viewport,
            slot,
            index,
            session.cache,
          );
          reresolved.push(result);
        } catch {
          // Skip failed re-resolutions
        }
      }

      if (reresolved.length > 0) {
        socket.emit("slots:batch_resolved", {
          viewportId: session.viewport.viewportId,
          slots: reresolved,
        });
      }
    }
  }
}
