/**
 * Placing a track on the display axis.
 *
 * Event time (see event-time.ts) puts capture and render on one shared axis of
 * 10ms slots. This module turns a slot position into seconds and applies the
 * one thing a user controls:
 *
 *     display seconds = event frame * 0.010 + offsetSeconds
 *
 * The offset is a pure translation. It may be negative. Manual dragging,
 * numeric nudging and a future cross-correlation alignment all move it, and
 * nothing else may touch it: no feature introduces a time scale or a continuous
 * warp, because warping the display to correct drift hides the symptom the
 * viewer exists to reveal.
 *
 * Every track on one clock domain shares an offset by default, so a re-INIT
 * cannot silently pull a segment out of alignment with its neighbours.
 */
import { FRAME_MS } from './dump-model.js';

const SECONDS_PER_FRAME = FRAME_MS / 1000;

export interface TrackTransform {
  /** Static shift, from a user drag or an alignment estimate. */
  offsetSeconds: number;
}

/** No shift: event time and display time coincide. */
export const IDENTITY_TRANSFORM: TrackTransform = { offsetSeconds: 0 };

export function makeTransform(offsetSeconds = 0): TrackTransform {
  return { offsetSeconds };
}

/** Event frame to display seconds. */
export function toDisplayTime(transform: TrackTransform, eventFrame: number): number {
  return eventFrame * SECONDS_PER_FRAME + transform.offsetSeconds;
}

/**
 * Display seconds back to a fractional event frame, for seeking.
 *
 * Exact, because the transform is a translation. Callers that need a whole slot
 * decide their own rounding: the event layout, not this module, owns the rule
 * for landing inside a gap.
 */
export function toEventFrame(transform: TrackTransform, displayTime: number): number {
  return (displayTime - transform.offsetSeconds) / SECONDS_PER_FRAME;
}
