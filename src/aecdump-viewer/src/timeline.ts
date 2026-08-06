/**
 * Placing a track on the workspace timeline.
 *
 * Tracks carry native times: a capture track is on the capture clock, a render
 * track on the render clock, an imported WAV on whatever clock recorded it.
 * Turning those into one shared axis is a display decision, and this is the
 * only place it is made:
 *
 *     display time = native time + offsetSeconds + driftCurve(native time)
 *
 * The two terms are deliberately separate. `offsetSeconds` is a static shift --
 * a user drag, or a cross-correlation result. `driftCurve` is a time-varying
 * correction for clocks that run at different rates, which no single offset can
 * express.
 *
 * Nothing here is baked into the parsed model, so the estimator behind the
 * curve stays swappable: windowed cross-correlation, smoothed call order, the
 * reported delay series, or a combination. The default is the honest one --
 * identity, with each track on its own clock and the user aligning it.
 */

/** A time-varying correction, sampled at arbitrary points and interpolated. */
export interface DriftCurve {
  /** Native times, strictly ascending. */
  times: Float64Array;
  /** Seconds to add at each corresponding time. */
  offsets: Float64Array;
}

export interface TrackTransform {
  /** Static shift, from a user drag or an alignment estimate. */
  offsetSeconds: number;
  /** Time-varying correction, or null when there is no evidence for one. */
  driftCurve: DriftCurve | null;
}

/** No shift and no warp: every track sits on its own clock. */
export const IDENTITY_TRANSFORM: TrackTransform = { offsetSeconds: 0, driftCurve: null };

export function makeTransform(offsetSeconds = 0, driftCurve: DriftCurve | null = null): TrackTransform {
  return { offsetSeconds, driftCurve };
}

/** Linear interpolation, holding the end values beyond the sampled range. */
function sampleCurve(curve: DriftCurve, time: number): number {
  const { times, offsets } = curve;
  if (times.length === 0) return 0;
  if (time <= times[0]) return offsets[0];
  if (time >= times[times.length - 1]) return offsets[offsets.length - 1];

  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  const span = times[high] - times[low];
  if (span === 0) return offsets[low];
  const ratio = (time - times[low]) / span;
  return offsets[low] + ratio * (offsets[high] - offsets[low]);
}

/** Native time to display time. */
export function toDisplayTime(transform: TrackTransform, nativeTime: number): number {
  const drift = transform.driftCurve ? sampleCurve(transform.driftCurve, nativeTime) : 0;
  return nativeTime + transform.offsetSeconds + drift;
}

/**
 * Display time back to native time, for seeking.
 *
 * With no drift curve this is exact. With one it is solved by bisection,
 * because the curve is defined against native time; the transform is assumed
 * monotonic, which holds for any physically meaningful clock relationship.
 */
export function toNativeTime(
  transform: TrackTransform,
  displayTime: number,
  { iterations = 40 }: { iterations?: number } = {}
): number {
  if (!transform.driftCurve) return displayTime - transform.offsetSeconds;

  // Bracket the answer, widening until it contains the target.
  let low = displayTime - transform.offsetSeconds - 1;
  let high = displayTime - transform.offsetSeconds + 1;
  for (let i = 0; i < 60 && toDisplayTime(transform, low) > displayTime; i++) low -= 1 << i;
  for (let i = 0; i < 60 && toDisplayTime(transform, high) < displayTime; i++) high += 1 << i;

  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    if (toDisplayTime(transform, mid) < displayTime) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
