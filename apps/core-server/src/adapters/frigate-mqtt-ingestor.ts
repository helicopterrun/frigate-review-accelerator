import mqtt from "mqtt";
import type { Server as SocketIOServer } from "socket.io";
import type { SemanticEntity } from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import { normalizeFrigateEvent, attachReviewToEntity } from "./frigate-entity-normalizer.js";
import type { FrigateRawEvent, FrigateRawReview } from "./frigate-http-client.js";
import { invalidateRangeForAllSessions } from "../realtime/slot-invalidator.js";
import {
  upsertEntityToDb,
  updateIngestState,
  getMqttTrackedCameras,
} from "../persistence/entity-store.js";
import { backfillRange } from "../services/http-backfill.js";

const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? "frigate";

let mqttClient: mqtt.MqttClient | null = null;
let _hadPreviousConnect = false; // distinguish initial connect from reconnect
let mqttStatus: {
  connected: boolean;
  lastMessageTime: number | null;
  messagesReceived: number;
  entitiesUpdated: number;
} = {
  connected: false,
  lastMessageTime: null,
  messagesReceived: 0,
  entitiesUpdated: 0,
};

export function getMqttStatus() {
  return { ...mqttStatus };
}

export function startMqttIngestor(index: SemanticIndex, io: SocketIOServer): void {
  const host = process.env.MQTT_HOST;
  const port = Number(process.env.MQTT_PORT ?? 1883);
  const user = process.env.MQTT_USER;
  const pass = process.env.MQTT_PASS;

  if (!host) {
    console.warn("[mqtt] MQTT_HOST not set, skipping MQTT connection");
    return;
  }

  const url = `mqtt://${host}:${port}`;
  console.log(`[mqtt] Connecting to ${url} as ${user ?? "(anonymous)"}...`);

  mqttClient = mqtt.connect(url, {
    username: user,
    password: pass,
    clientId: `frigate-accelerator-${Date.now()}`,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  mqttClient.on("connect", () => {
    mqttStatus.connected = true;
    console.log("[mqtt] Connected to MQTT broker");

    // Subscribe to Frigate topics
    const topics = [
      `${TOPIC_PREFIX}/events`,
      `${TOPIC_PREFIX}/reviews`,
      `${TOPIC_PREFIX}/available`,
    ];

    mqttClient!.subscribe(topics, { qos: 0 }, (err) => {
      if (err) {
        console.error("[mqtt] Subscribe error:", err);
      } else {
        console.log(`[mqtt] Subscribed to: ${topics.join(", ")}`);
      }
    });

    if (_hadPreviousConnect) {
      // Reconnect: back-fill any events missed during the disconnect gap
      fillGapAfterReconnect(index, io);
    } else {
      _hadPreviousConnect = true;
      io.emit("semantic:freshness", { status: "live" });
    }
  });

  mqttClient.on("message", (topic: string, payload: Buffer) => {
    mqttStatus.messagesReceived++;
    mqttStatus.lastMessageTime = Date.now() / 1000;

    try {
      const data = JSON.parse(payload.toString());
      handleMessage(topic, data, index, io);
    } catch (err) {
      // Not all MQTT messages are JSON (e.g., frigate/available is plain text)
      const text = payload.toString();
      if (topic === `${TOPIC_PREFIX}/available`) {
        console.log(`[mqtt] Frigate available: ${text}`);
      }
    }
  });

  mqttClient.on("disconnect", () => {
    mqttStatus.connected = false;
    console.warn("[mqtt] Disconnected from MQTT broker");
    io.emit("semantic:freshness", { status: "stale" });
  });

  mqttClient.on("reconnect", () => {
    console.log("[mqtt] Reconnecting to MQTT broker...");
    io.emit("semantic:freshness", { status: "recovering" });
  });

  mqttClient.on("error", (err) => {
    console.error("[mqtt] Error:", err.message);
  });
}

function handleMessage(
  topic: string,
  data: any,
  index: SemanticIndex,
  io: SocketIOServer,
): void {
  if (topic === `${TOPIC_PREFIX}/events`) {
    handleEventMessage(data, index, io);
  } else if (topic === `${TOPIC_PREFIX}/reviews`) {
    handleReviewMessage(data, index, io);
  }
}

function handleEventMessage(data: any, index: SemanticIndex, io: SocketIOServer): void {
  // Frigate MQTT event messages come as the event object directly
  // or sometimes wrapped in { type: "new"|"update"|"end", before: {...}, after: {...} }
  let raw: FrigateRawEvent;

  if (data.after) {
    // Wrapped format: use the "after" state
    raw = data.after as FrigateRawEvent;
  } else if (data.id && data.camera) {
    // Direct event object
    raw = data as FrigateRawEvent;
  } else {
    return; // Unrecognized format
  }

  if (!raw.id || !raw.camera) return;

  const entity = normalizeFrigateEvent(raw);
  const existing = index.get(entity.id);

  // Merge: keep review data from existing if present
  const merged: SemanticEntity = existing
    ? { ...entity, review: existing.review ?? entity.review }
    : entity;

  index.upsert(merged);
  upsertEntityToDb(merged);
  updateIngestState("mqtt", merged.camera, {
    lastMqttMessageTime: Date.now() / 1000,
    lastEventTime: merged.startTime,
  });
  mqttStatus.entitiesUpdated++;

  // Invalidate overlapping slots in all active viewport sessions
  invalidateRangeForAllSessions(
    io,
    merged.camera,
    merged.startTime,
    merged.endTime ?? merged.startTime + 10,
    data.type === "new" ? "new_event" : "event_update",
    index,
  );
}

function handleReviewMessage(data: any, index: SemanticIndex, io: SocketIOServer): void {
  // Frigate review messages come as { type: "new"|"update"|"end", before: {...}, after: {...} }
  let review: FrigateRawReview;

  if (data.after) {
    review = data.after as FrigateRawReview;
  } else if (data.id && data.camera) {
    review = data as FrigateRawReview;
  } else {
    return;
  }

  if (!review.data?.detections) return;

  // Attach review to all referenced entities
  for (const eventId of review.data.detections) {
    const entity = index.get(eventId);
    if (entity) {
      const updated = attachReviewToEntity(entity, review);
      index.upsert(updated);
      upsertEntityToDb(updated);

      invalidateRangeForAllSessions(
        io,
        entity.camera,
        entity.startTime,
        entity.endTime ?? entity.startTime + 10,
        "review_update",
        index,
      );
    }
  }
}

/**
 * On MQTT reconnect: read the last known message time per camera from
 * ingest_state and back-fill any events missed during the disconnect gap.
 */
async function fillGapAfterReconnect(
  index: SemanticIndex,
  io: SocketIOServer,
): Promise<void> {
  let cameras: ReturnType<typeof getMqttTrackedCameras>;
  try {
    cameras = getMqttTrackedCameras();
  } catch {
    // DB not initialized or no records — skip
    io.emit("semantic:freshness", { status: "live" });
    return;
  }

  if (cameras.length === 0) {
    io.emit("semantic:freshness", { status: "live" });
    return;
  }

  console.log(`[mqtt] Reconnect gap-fill for ${cameras.length} camera(s)`);
  io.emit("semantic:freshness", { status: "recovering" });

  const nowSec = Date.now() / 1000;

  for (const { camera, lastMqttMessageTime } of cameras) {
    const gapStart = lastMqttMessageTime - 60; // 60-second overlap buffer
    try {
      const { eventsLoaded } = await backfillRange(
        index,
        [camera],
        gapStart,
        nowSec,
      );
      console.log(`[mqtt] Gap-fill ${camera}: loaded ${eventsLoaded} events`);
    } catch (err) {
      console.warn(`[mqtt] Gap-fill failed for ${camera}:`, err);
    }
  }

  io.emit("semantic:freshness", { status: "live" });
}
