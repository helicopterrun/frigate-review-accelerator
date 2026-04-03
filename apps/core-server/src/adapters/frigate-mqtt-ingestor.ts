import mqtt from "mqtt";
import type { Server as SocketIOServer } from "socket.io";
import type { SemanticEntity } from "@frigate-review/shared-types";
import { SemanticIndex } from "../semantic/semantic-index.js";
import {
  normalizeFrigateEvent,
  attachReviewToEntity,
  applyEnrichmentUpdate,
} from "./frigate-entity-normalizer.js";
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
let _stalenessTimer: ReturnType<typeof setInterval> | null = null;
let _isStale = false; // true when we've emitted "stale" due to silence
const STALE_THRESHOLD_SEC = 60; // emit stale if no message for this long
const STALE_CHECK_INTERVAL_MS = 15_000;

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
      `${TOPIC_PREFIX}/tracked_object_update`,
      `${TOPIC_PREFIX}/stats`,
    ];

    mqttClient!.subscribe(topics, { qos: 0 }, (err) => {
      if (err) {
        console.error("[mqtt] Subscribe error:", err);
      } else {
        console.log(`[mqtt] Subscribed to: ${topics.join(", ")}`);
      }
    });

    // Start staleness detection timer on first connect
    if (!_stalenessTimer) {
      _stalenessTimer = setInterval(() => checkStaleness(io), STALE_CHECK_INTERVAL_MS);
    }

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
    _isStale = false; // reset so reconnect → live transition works cleanly
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
  // Any message from Frigate means it's alive — recover from stale if needed
  if (_isStale) {
    _isStale = false;
    io.emit("semantic:freshness", { status: "live" });
  }

  if (topic === `${TOPIC_PREFIX}/events`) {
    handleEventMessage(data, index, io);
  } else if (topic === `${TOPIC_PREFIX}/reviews`) {
    handleReviewMessage(data, index, io);
  } else if (topic === `${TOPIC_PREFIX}/tracked_object_update`) {
    handleTrackedObjectUpdate(data, index, io);
  }
  // frigate/stats and frigate/available are heartbeat signals only — handled above
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
 * Handle frigate/tracked_object_update messages.
 *
 * These fire during active tracking and carry enrichment data (face matches,
 * sub-labels, LPR results) that improves Type B scoring. We merge enrichments
 * onto the existing entity without overwriting clean snapshot/score data.
 */
function handleTrackedObjectUpdate(
  data: any,
  index: SemanticIndex,
  io: SocketIOServer,
): void {
  let raw: FrigateRawEvent;

  if (data.after) {
    raw = data.after as FrigateRawEvent;
  } else if (data.id && data.camera) {
    raw = data as FrigateRawEvent;
  } else {
    return;
  }

  if (!raw.id || !raw.camera) return;

  const existing = index.get(raw.id);
  if (!existing) {
    // Entity not yet in index — normalize as a full event (will be enriched later)
    const entity = normalizeFrigateEvent(raw);
    index.upsert(entity);
    upsertEntityToDb(entity);
    return;
  }

  const updated = applyEnrichmentUpdate(existing, raw);

  // Skip write if nothing actually changed
  if (
    updated.enrichments === existing.enrichments &&
    updated.subLabel === existing.subLabel &&
    updated.topScore === existing.topScore
  ) {
    return;
  }

  index.upsert(updated);
  upsertEntityToDb(updated);
  updateIngestState("mqtt", updated.camera, {
    lastMqttMessageTime: Date.now() / 1000,
  });
  mqttStatus.entitiesUpdated++;

  // Invalidate affected slots so Type B re-scores with enrichment bonus
  invalidateRangeForAllSessions(
    io,
    updated.camera,
    updated.startTime,
    updated.endTime ?? updated.startTime + 10,
    "enrichment_update",
    index,
  );
}

/**
 * Periodic staleness check: if MQTT is connected but Frigate has been silent
 * for STALE_THRESHOLD_SEC, emit stale. Recover automatically on next message.
 */
function checkStaleness(io: SocketIOServer): void {
  if (!mqttStatus.connected) return;
  if (_isStale) return; // already emitted stale, waiting for recovery

  const lastMsg = mqttStatus.lastMessageTime;
  if (lastMsg == null) return; // never received a message yet

  const silenceSec = Date.now() / 1000 - lastMsg;
  if (silenceSec >= STALE_THRESHOLD_SEC) {
    _isStale = true;
    console.warn(
      `[mqtt] No messages for ${Math.round(silenceSec)}s — marking stale`,
    );
    io.emit("semantic:freshness", { status: "stale" });
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
