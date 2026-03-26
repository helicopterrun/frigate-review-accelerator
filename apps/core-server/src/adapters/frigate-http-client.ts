const FRIGATE_URL = process.env.FRIGATE_URL ?? "http://192.168.50.207:5000";

// ── Raw Frigate API response types ──────────────────────────────────────────

export interface FrigateRawEvent {
  id: string;
  camera: string;
  label: string;
  sub_label?: string | null;
  zones: string[];
  start_time: number;
  end_time: number | null;
  has_clip: boolean;
  has_snapshot: boolean;
  plus_id?: string | null;
  retain_indefinitely: boolean;
  top_score?: number | null;
  false_positive?: boolean | null;
  box?: number[] | null;
  data: {
    box?: number[];
    region?: number[];
    score?: number;
    top_score?: number;
    attributes?: Array<{ label: string; score: number }>;
    average_estimated_speed?: number;
    type?: string;
    max_severity?: string;
  };
}

export interface FrigateRawReview {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: string;
  thumb_path?: string;
  data: {
    detections: string[];
    objects: string[];
    zones: string[];
    sub_labels?: string[];
    audio?: string[];
  };
  has_been_reviewed: boolean;
}

// ── Client methods ──────────────────────────────────────────────────────────

export async function fetchEvents(params: {
  cameras?: string[];
  after?: number;
  before?: number;
  label?: string;
  hasSnapshot?: boolean;
  limit?: number;
}): Promise<FrigateRawEvent[]> {
  const url = new URL(`${FRIGATE_URL}/api/events`);
  if (params.after != null) url.searchParams.set("after", String(params.after));
  if (params.before != null) url.searchParams.set("before", String(params.before));
  if (params.label) url.searchParams.set("label", params.label);
  if (params.hasSnapshot) url.searchParams.set("has_snapshot", "1");
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.cameras && params.cameras.length === 1) {
    url.searchParams.set("camera", params.cameras[0]);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Frigate /api/events failed: ${res.status}`);
  }
  return res.json() as Promise<FrigateRawEvent[]>;
}

export async function fetchReviews(params: {
  after?: number;
  before?: number;
  camera?: string;
  limit?: number;
}): Promise<FrigateRawReview[]> {
  const url = new URL(`${FRIGATE_URL}/api/review`);
  if (params.after != null) url.searchParams.set("after", String(params.after));
  if (params.before != null) url.searchParams.set("before", String(params.before));
  if (params.camera) url.searchParams.set("camera", params.camera);
  if (params.limit) url.searchParams.set("limit", String(params.limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Frigate /api/review failed: ${res.status}`);
  }
  return res.json() as Promise<FrigateRawReview[]>;
}

export function getSnapshotUrl(eventId: string): string {
  return `${FRIGATE_URL}/api/events/${encodeURIComponent(eventId)}/snapshot.jpg`;
}

export function getMediaServiceSnapshotUrl(eventId: string): string {
  return `/media/snapshot/${encodeURIComponent(eventId)}`;
}

export { FRIGATE_URL };
