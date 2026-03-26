import type { PlaybackState } from "@frigate-review/shared-types";

export interface PlaybackContext {
  userIsScrubbing: boolean;
  cursorNearNow: boolean;
  streamHealthy: boolean;
  cursorSettled: boolean;
  hasPreparedRecording: boolean;
  tCursor: number;
  tNow: number;
  tViewStart: number;
  tViewEnd: number;
}

const NEAR_NOW_THRESHOLD_SEC = 30;

export function nextPlaybackState(ctx: PlaybackContext): PlaybackState {
  if (ctx.userIsScrubbing) {
    return "SCRUBBING";
  }

  const viewportIncludesNow =
    ctx.tViewStart <= ctx.tNow && ctx.tNow < ctx.tViewEnd;

  if (viewportIncludesNow && ctx.cursorNearNow && ctx.streamHealthy) {
    return "LIVE_STREAM";
  }

  if (ctx.cursorSettled && ctx.hasPreparedRecording) {
    return "PLAYBACK_RECORDING";
  }

  if (viewportIncludesNow && ctx.cursorNearNow) {
    return "FOLLOW_NOW_IDLE";
  }

  return "SCRUB_REVIEW";
}

export function isCursorNearNow(tCursor: number, tNow: number): boolean {
  return Math.abs(tCursor - tNow) < NEAR_NOW_THRESHOLD_SEC;
}
