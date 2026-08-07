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

/**
 * A time-varying correction, sampled at arbitrary points and interpolated.
 *
 * Build one with makeDriftCurve, which enforces the invariants seeking depends
 * on. Constructing the object directly skips those checks.
 */
export interface DriftCurve {
  /** Native times, strictly ascending. */
  times: Float64Array;
  /** Seconds to add at each corresponding time. */
  offsets: Float64Array;
}

/**
 * Validates and builds a drift curve.
 *
 * Three invariants matter, and all three are about keeping the transform
 * invertible, because seeking has to map a click back to a native time:
 *
 *   - equal lengths and finite values, or interpolation yields NaN
 *   - strictly ascending times, or the search for a bracketing pair is
 *     meaningless
 *   - strictly ascending display knots (time + offset), or the transform is
 *     not monotonic. A correction falling faster than real time makes display
 *     time run backwards, and bisection then has several roots to choose
 *     between and no basis to pick one. A plateau is just as bad: seeking
 *     lands anywhere in it.
 */
export function makeDriftCurve(times: ArrayLike<number>, offsets: ArrayLike<number>): DriftCurve {
  if (times.length !== offsets.length) {
    throw new Error(`drift curve: ${times.length} times against ${offsets.length} offsets`);
  }
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || !Number.isFinite(offsets[i])) {
      throw new Error(`drift curve: non-finite value at index ${i}`);
    }
    if (i > 0) {
      if (times[i] <= times[i - 1]) {
        throw new Error(`drift curve: times must ascend strictly (index ${i})`);
      }
      const previousDisplay = times[i - 1] + offsets[i - 1];
      const display = times[i] + offsets[i];
      if (display <= previousDisplay) {
        throw new Error(
          `drift curve: correction at index ${i} reverses or halts display time, ` +
            `which would make seeking ambiguous`
        );
      }
    }
  }
  return { times: Float64Array.from(times), offsets: Float64Array.from(offsets) };
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

  // Bracket the answer, widening until it contains the target. Uses 2 ** i
  // rather than 1 << i, which wraps to negative past 31 bits and would widen
  // the bracket the wrong way.
  let low = displayTime - transform.offsetSeconds - 1;
  let high = displayTime - transform.offsetSeconds + 1;
  let bracketed = false;
  for (let i = 0; i < 64; i++) {
    if (toDisplayTime(transform, low) <= displayTime && toDisplayTime(transform, high) >= displayTime) {
      bracketed = true;
      break;
    }
    if (toDisplayTime(transform, low) > displayTime) low -= 2 ** i;
    if (toDisplayTime(transform, high) < displayTime) high += 2 ** i;
  }
  // A validated curve is monotonic and bounded, so this cannot happen; if it
  // somehow does, say so rather than returning a silently wrong position.
  if (!bracketed) {
    throw new Error(`timeline: could not bracket display time ${displayTime}`);
  }

  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    if (toDisplayTime(transform, mid) < displayTime) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
