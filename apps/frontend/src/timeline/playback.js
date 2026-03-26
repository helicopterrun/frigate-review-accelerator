/**
 * Playback state machine — decides what the UI should present.
 *
 * States:
 *   LIVE_STREAM         — showing live camera feed (cursor near now, stream healthy)
 *   SCRUB_REVIEW        — user is actively scrubbing the timeline
 *   PLAYBACK_RECORDING  — playing back a recorded segment
 *   FOLLOW_NOW_IDLE     — cursor follows wall-clock, no active playback
 */

export const PlaybackState = {
  LIVE_STREAM: 'LIVE_STREAM',
  SCRUB_REVIEW: 'SCRUB_REVIEW',
  PLAYBACK_RECORDING: 'PLAYBACK_RECORDING',
  FOLLOW_NOW_IDLE: 'FOLLOW_NOW_IDLE',
};

/**
 * Determine the next playback state from context.
 *
 * @param {object} ctx
 * @param {boolean}  ctx.userIsScrubbing
 * @param {object}   ctx.viewport         — TimelineViewport
 * @param {number}   ctx.tNowMs
 * @param {boolean}  ctx.cursorNearNow    — cursor within a few seconds of now
 * @param {boolean}  ctx.streamHealthy    — live stream is connected and delivering frames
 * @param {boolean}  ctx.cursorSettled    — cursor has stopped moving for a threshold
 * @param {boolean}  ctx.hasPreparedRecording — a recording segment is ready for playback
 */
export function nextPlaybackState(ctx) {
  if (ctx.userIsScrubbing) {
    return PlaybackState.SCRUB_REVIEW;
  }

  const viewportIncludesNow =
    ctx.viewport.tViewStart <= ctx.tNowMs &&
    ctx.tNowMs < ctx.viewport.tViewEnd;

  if (viewportIncludesNow && ctx.cursorNearNow && ctx.streamHealthy) {
    return PlaybackState.LIVE_STREAM;
  }

  if (ctx.cursorSettled && ctx.hasPreparedRecording) {
    return PlaybackState.PLAYBACK_RECORDING;
  }

  return PlaybackState.FOLLOW_NOW_IDLE;
}
