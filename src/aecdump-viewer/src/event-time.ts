/**
 * Event time: the shared visual axis for capture and render.
 *
 * The dump holds two dense sample streams on two hardware clocks, and an
 * ordering between their API calls. It holds no timestamp for either, so there
 * is no `renderTime = f(captureTime)` to recover. Putting both on one axis is
 * therefore a declared visualization policy, and this module is where it is
 * declared.
 *
 * Every capture and render block gets one 10ms **event slot** in its own lane.
 * The lanes share a frontier -- the first slot the leading lane has not reached
 * -- and a lagging lane backfills slots behind it, which is what absorbs
 * ordinary serialization clustering. `ccccrrrr` puts four capture blocks in
 * slots 0-3 and then backfills the four render blocks into the same slots, so
 * clustered delivery draws as alignment rather than as a defect.
 *
 * A lane that falls further behind than `allowedLatenessFrames` is **rebased**
 * to the frontier instead, and the slots it skipped become a structural gap in
 * that lane. Rebase, not wrap: positions only ever move forward.
 *
 * Two consequences worth stating plainly:
 *
 *   - The layout never touches audio. A gap is empty display space, not silence
 *     appended to a buffer; playback and export read the dense native samples
 *     exactly as `unpack_aecdump` wrote them.
 *   - `allowedLatenessFrames` is a policy, not a measurement. The file cannot
 *     distinguish a long healthy batch from a real one-sided interruption, so
 *     something has to decide, and it is better that the something is one
 *     declared number than a stack of trend fitting and robust statistics.
 *     It is recorded with the layout so a rendering is always reproducible.
 */
import { CALL_CAPTURE, CALL_RENDER, CallOrderSegment, FRAME_MS } from './dump-model.js';

/** Which lane a block belongs to. Input and ref_out share the capture lane. */
export type EventStream = 'capture' | 'render';

/**
 * How far a lane may fall behind the frontier before it is rebased, in 10ms
 * frames. 10 frames is 100ms.
 *
 * A product heuristic, not a derived bound. It has to sit above the largest
 * healthy delivery batch and below the smallest interruption worth drawing, and
 * nothing in the dump establishes either edge -- serialization is not
 * guaranteed to cluster within 100ms, and a real interruption can be shorter
 * than one. 100ms is a starting value to be confirmed against a corpus of dumps
 * with known batching and known stalls; the layout records the value it used so
 * a rendering under a different policy is always reproducible.
 *
 * The comparison is strict, so exactly 100ms of lateness still backfills and
 * 110ms is the first lag that rebases.
 *
 * Being wrong here is visible and adjustable rather than silent, but the two
 * directions are not equally cheap. Too large and a real interruption draws as
 * steady alignment, with the deficit visible only in the call-order lane. Too
 * small and both lanes rebase every cycle, each ending up half empty with the
 * extent doubled -- a much louder failure than a single spurious gap.
 */
export const DEFAULT_ALLOWED_LATENESS_FRAMES = 10;

/**
 * A maximal slope-one stretch of one lane: native frames `nativeStartFrame ..
 * nativeStartFrame + frameCount` sit at event frames `eventStartFrame ..`.
 *
 * Storing runs rather than a position per frame keeps the mapping small (a
 * healthy stream is one run) and keeps recorded audio structurally distinct
 * from empty display space.
 */
export interface EventTimeRun {
  nativeStartFrame: number;
  eventStartFrame: number;
  frameCount: number;
}

/** Event slots a lane skipped when it was rebased. */
export interface EventTimeGap {
  stream: EventStream;
  eventStartFrame: number;
  /** Exclusive. */
  eventEndFrame: number;
  /** Native frame that resumes after the gap. */
  nextNativeFrame: number;
  /** How far behind the frontier the lane had fallen. */
  observedLagFrames: number;
}

export interface EventTimeLayout {
  /** The policy this layout was built under, so a rendering is reproducible. */
  allowedLatenessFrames: number;
  /** One past the last occupied slot. */
  extentFrames: number;
  captureRuns: EventTimeRun[];
  renderRuns: EventTimeRun[];
  gaps: EventTimeGap[];
}

/** Seconds spanned by a count of event frames. */
export function eventFramesToSeconds(frames: number): number {
  return (frames * FRAME_MS) / 1000;
}

class LaneBuilder {
  readonly runs: EventTimeRun[] = [];
  /** Slot this lane would use next if it is allowed to backfill. */
  next = 0;
  /** Native frames placed so far. Kept incrementally: a rebase must not have
   *  to walk the runs, or a dump that rebases often lays out quadratically. */
  native = 0;
  private open: EventTimeRun | null = null;

  constructor(readonly stream: EventStream) {}

  /** Starts a fresh run at `eventFrame`, ending any run in progress. */
  rebaseTo(eventFrame: number): void {
    this.open = null;
    this.next = eventFrame;
  }

  /** Places one block at `this.next` and advances. */
  place(): void {
    if (this.open === null) {
      this.open = {
        nativeStartFrame: this.native,
        eventStartFrame: this.next,
        frameCount: 0,
      };
      this.runs.push(this.open);
    }
    this.open.frameCount++;
    this.native++;
    this.next++;
  }
}

/**
 * Builds the event-time layout for a dump.
 *
 * Takes every segment, because event time is continuous across INIT: an INIT
 * cuts the streams into separately formatted tracks but resets neither clock,
 * so laying each segment out from zero would silently realign at every
 * reconfiguration.
 *
 * Pure: the same segments and the same policy always produce the same runs and
 * gaps. Characters that are neither `c` nor `r` are ignored, as are INIT,
 * CONFIG and RUNTIME_SETTING events -- they carry no audio, so they occupy no
 * slot.
 */
export function layOutEventTime(
  segments: CallOrderSegment[],
  allowedLatenessFrames: number = DEFAULT_ALLOWED_LATENESS_FRAMES
): EventTimeLayout {
  if (Number.isNaN(allowedLatenessFrames) || allowedLatenessFrames < 0) {
    throw new Error(`event time: allowed lateness must be >= 0, got ${allowedLatenessFrames}`);
  }

  const capture = new LaneBuilder('capture');
  const render = new LaneBuilder('render');
  const gaps: EventTimeGap[] = [];
  let frontier = 0;

  for (const segment of segments) {
    for (const call of segment.calls) {
      let lane: LaneBuilder;
      if (call === CALL_CAPTURE) lane = capture;
      else if (call === CALL_RENDER) lane = render;
      else continue;

      const lag = frontier - lane.next;
      // A lag equal to the tolerance still backfills; one frame more rebases.
      if (lag > allowedLatenessFrames) {
        gaps.push({
          stream: lane.stream,
          eventStartFrame: lane.next,
          eventEndFrame: frontier,
          nextNativeFrame: lane.native,
          observedLagFrames: lag,
        });
        lane.rebaseTo(frontier);
      }

      lane.place();
      // Each event advances the frontier by at most one, so the extent can
      // never exceed the number of events however badly the policy is chosen.
      if (lane.next > frontier) frontier = lane.next;
    }
  }

  return {
    allowedLatenessFrames,
    extentFrames: frontier,
    captureRuns: capture.runs,
    renderRuns: render.runs,
    gaps,
  };
}

/** The runs for one lane. */
export function runsFor(layout: EventTimeLayout, stream: EventStream): EventTimeRun[] {
  return stream === 'capture' ? layout.captureRuns : layout.renderRuns;
}

/**
 * Native position to event position, for drawing a cursor.
 *
 * Positions are fractional frames, not block indices: a cursor part-way through
 * a block must draw part-way through its slot, and the mapping is slope one
 * inside a run so the fraction passes straight through.
 *
 * Returns null for a position the layout never placed. The position exactly at
 * the end of the last run is placed -- it is where a finished playback cursor
 * sits. At a rebase the result jumps over the gap, which is what makes a
 * playing cursor skip empty display space instead of waiting through it.
 */
export function toEventFrame(
  layout: EventTimeLayout,
  stream: EventStream,
  nativeFrame: number
): number | null {
  if (!Number.isFinite(nativeFrame)) return null;
  const runs = runsFor(layout, stream);
  const run = findRun(runs, nativeFrame, (r) => r.nativeStartFrame);
  if (run) return run.eventStartFrame + (nativeFrame - run.nativeStartFrame);

  // The exclusive end of the final run: the position a cursor reaches when the
  // track finishes playing, which no half-open run contains.
  const last = runs[runs.length - 1];
  if (last && nativeFrame === last.nativeStartFrame + last.frameCount) {
    return last.eventStartFrame + last.frameCount;
  }
  return null;
}

/** How a clicked event position was resolved to a native position. */
export type SeekResolution = 'exact' | 'snapped-forward' | 'clamped-to-end' | 'empty';

export interface SeekResult {
  /** Fractional native frame; multiply by the track's samples per frame. */
  nativeFrame: number;
  resolution: SeekResolution;
}

/**
 * Event position to native position, for seeking. Resolved per track.
 *
 * Seeking inverts the visible layout rather than consulting the call order
 * again: a second, hidden mapping would land the cursor somewhere the user
 * cannot see a reason for.
 *
 * Inside a run the inverse is exact and keeps the fractional part, so clicking
 * part-way through a drawn block selects the sample under the pointer rather
 * than the start of the block. Inside a gap, or before the first run, it snaps
 * forward to the first block after it -- an exact block boundary, so the
 * fraction is deliberately dropped. Past the last run it clamps to the end of
 * the audio, not to the start of the final block. The caller should show which
 * of those happened, so a snap is not mistaken for an exact position.
 */
export function toNativeFrame(
  layout: EventTimeLayout,
  stream: EventStream,
  eventFrame: number
): SeekResult {
  const runs = runsFor(layout, stream);
  if (runs.length === 0) return { nativeFrame: 0, resolution: 'empty' };
  if (!Number.isFinite(eventFrame)) {
    throw new Error(`event time: cannot seek to ${eventFrame}`);
  }

  const run = findRun(runs, eventFrame, (r) => r.eventStartFrame);
  if (run) {
    return {
      nativeFrame: run.nativeStartFrame + (eventFrame - run.eventStartFrame),
      resolution: 'exact',
    };
  }

  // Before, or between runs: take the first run that starts after this point.
  const next = runs.find((r) => r.eventStartFrame > eventFrame);
  if (next) return { nativeFrame: next.nativeStartFrame, resolution: 'snapped-forward' };

  const last = runs[runs.length - 1];
  return {
    nativeFrame: last.nativeStartFrame + last.frameCount,
    resolution: 'clamped-to-end',
  };
}

/** Binary search for the run containing `frame` on the axis `startOf` reads. */
function findRun(
  runs: EventTimeRun[],
  frame: number,
  startOf: (run: EventTimeRun) => number
): EventTimeRun | null {
  let low = 0;
  let high = runs.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = startOf(runs[mid]);
    if (frame < start) high = mid - 1;
    else if (frame >= start + runs[mid].frameCount) low = mid + 1;
    else return runs[mid];
  }
  return null;
}
