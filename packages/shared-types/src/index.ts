// ── Primitives ──────────────────────────────────────────────────────────────

export type EventId = string;
export type CameraName = string;
export type TimestampSec = number;

export type PlaybackState =
  | "LIVE_STREAM"
  | "SCRUBBING"
  | "SCRUB_REVIEW"
  | "PLAYBACK_RECORDING"
  | "FOLLOW_NOW_IDLE";

export type SlotStatus = "clean" | "dirty" | "resolving";
export type SemanticFreshness = "live" | "recovering" | "stale";
export type ResolvedStrategy = "A" | "B";

// ── Filter state ────────────────────────────────────────────────────────────

export interface FilterState {
  objectLabels?: string[];
  zones?: string[];
  confidenceMin?: number;
}

export interface ClientViewportState {
  isScrubbing?: boolean;
  wantsLive?: boolean;
  scrollDirection?: "forward" | "backward" | "none";
}

// ── Client → Server events ──────────────────────────────────────────────────

export interface ViewportSubscribeEvent {
  viewportId: string;
  cameraIds: string[];
  tCursor: number;
  tWheel: number;
  cSlots: number;
  filters: FilterState;
  clientState?: ClientViewportState;
}

export interface ViewportUpdateEvent {
  viewportId: string;
  tCursor: number;
  tWheel: number;
  clientState?: ClientViewportState;
}

export interface FiltersUpdateEvent {
  viewportId: string;
  filters: FilterState;
}

export interface PlaybackRequestEvent {
  viewportId: string;
  mode: "play";
  startTime: number;
}

export interface PlaybackStopEvent {
  viewportId: string;
}

// ── Server → Client events ──────────────────────────────────────────────────

export interface ViewportSubscribedEvent {
  viewportId: string;
  cameraIds: string[];
  tCursor: number;
  tWheel: number;
  cSlots: number;
  serverTime: number;
  playbackState: PlaybackState;
  semanticFreshness: SemanticFreshness;
}

export interface SlotResolvedEvent {
  viewportId: string;
  slotIndex: number;
  resolvedStrategy: ResolvedStrategy;
  mediaUrl: string;
  sourceTimestamp: number;
  winnerEntityId?: string;
  score?: number;
  cacheHit: boolean;
  status: SlotStatus;
}

export interface SlotsBatchResolvedEvent {
  viewportId: string;
  slots: SlotResolvedEvent[];
}

export interface SlotDirtyEvent {
  viewportId: string;
  slotIndex: number;
  reason: string;
}

export interface SlotsDirtyEvent {
  viewportId: string;
  slotIndices: number[];
  reason: string;
}

export interface PlaybackStateEvent {
  viewportId: string;
  state: PlaybackState;
  tCursor: number;
  recordingReady?: boolean;
}

export interface SemanticFreshnessEvent {
  viewportId: string;
  status: SemanticFreshness;
  lastMqttMessageTime?: number;
}

export interface ErrorNonfatalEvent {
  viewportId: string;
  code: string;
  message: string;
  severity: "warn" | "error";
}

// ── Timeline model ──────────────────────────────────────────────────────────

export interface TimelineViewport {
  viewportId: string;
  cameraIds: string[];
  tCursor: number;
  tWheel: number;
  cSlots: number;
  tDiv: number;
  tViewStart: number;
  tViewEnd: number;
  filters: FilterState;
}

export interface TimelineSlot {
  index: number;
  tSlotStart: number;
  tSlotEnd: number;
  tSlotCenter: number;
}

// ── Semantic entity model ────────────────────────────────────────────────────

export interface SemanticEntity {
  id: EventId;
  camera: CameraName;
  label: string;
  subLabel?: string | null;

  startTime: TimestampSec;
  endTime?: TimestampSec | null;

  score?: number | null;
  topScore?: number | null;
  area?: number | null;

  stationary?: boolean | null;
  positionChanges?: number | null;

  currentZones: string[];
  enteredZones: string[];

  snapshot?: {
    available: boolean;
    frameTime?: TimestampSec | null;
    score?: number | null;
    path?: string | null;
  };

  review?: {
    reviewId?: string | null;
    severity?: "alert" | "detection" | "info" | null;
    reviewed?: boolean | null;
  };

  enrichments?: {
    face?: string | null;
    licensePlate?: string | null;
    classification?: string | null;
    description?: string | null;
  };

  lastUpdated: TimestampSec;
}

export interface TypeBRequest {
  cameraFilter: string[];
  objectFilter?: string[];
  zoneFilter?: string[];
  confidenceMin?: number;
  includeStationary?: boolean;
  slotStart: TimestampSec;
  slotEnd: TimestampSec;
  slotCenter: TimestampSec;
}

export interface TypeBResult {
  ok: boolean;
  eventId?: EventId;
  score?: number;
  reason?: string;
  snapshotTime?: TimestampSec;
  mediaRef?: string;
  label?: string;
}

// ── Media service types ─────────────────────────────────────────────────────

export interface FrameExtractRequest {
  camera: string;
  timestamp: number;
  mode?: "fast" | "accurate";
  format?: "jpg" | "webp";
  width?: number;
}

export interface FrameExtractResponse {
  ok: boolean;
  cache_hit: boolean;
  media_url: string;
  source: string;
  requested_timestamp: number;
  resolved_timestamp: number;
}
