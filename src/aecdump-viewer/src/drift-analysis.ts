/**
 * Render/capture call-order analysis.
 *
 * `unpack_aecdump --full` writes one character per stream event in file order:
 * `r` for a render (reverse) call, `c` for a capture call. Both carry 10ms of
 * audio, so counting them tells you how the two device clocks tracked each
 * other over the call -- something neither the WAVs nor Audacity can show.
 *
 * Plotting cumulative render-minus-capture time against capture time:
 *
 *   flat at zero   both streams in lockstep
 *   constant slope the two clocks run at different rates, e.g. a USB speaker
 *                  against an internal microphone
 *   step down      render stopped for a while (a playout gap)
 *   step up        a burst of render calls, usually a buffering hiccup
 *
 * Divergence between this measured drift and the delay the client reported in
 * `Stream.delay` is the classic signature of a delay-estimation bug.
 */
import { CALL_CAPTURE, CALL_RENDER, CallOrderSegment, FRAME_MS } from './dump-model.js';

export interface DriftPoint {
  /** Capture frame index within the dump. */
  captureFrame: number;
  /** Seconds from the start of the capture timeline. */
  time: number;
  /** Render calls seen so far in this segment. */
  renderFrames: number;
  /** renderFrames minus capture frames, in frames. */
  driftFrames: number;
  /** The same figure in milliseconds. */
  driftMs: number;
}

export interface DriftDiscontinuity {
  captureFrame: number;
  time: number;
  /** Change in drift at this point, in milliseconds. Negative is a render gap. */
  stepMs: number;
}

/**
 * How each stream is delivered to APM.
 *
 * APM always processes 10ms frames, but a caller holding larger buffers calls
 * it several times in a row -- a 40ms render buffer produces four render calls
 * back to back. That shows up in the call order as runs (`ccccrrrr`) and is
 * worth reporting on its own: "render arrives in 40ms blocks while capture is
 * 10ms" is a fact about the audio stack, not a fault.
 *
 * It also has to be measured before drift can be, because block granularity
 * looks exactly like drift if you sample naively.
 */
export interface BlockStructure {
  /** Capture calls per delivery block. 1 means one frame at a time. */
  captureBlockFrames: number;
  /** Render calls per delivery block. */
  renderBlockFrames: number;
  /** Block durations in ms, for display. */
  captureBlockMs: number;
  renderBlockMs: number;
}

export interface DriftAnalysis {
  startFrame: number;
  blocks: BlockStructure;
  /** Capture frames the discontinuity window actually spanned. */
  discontinuityWindowFrames: number;
  /** One point per capture call, in order. */
  points: DriftPoint[];
  discontinuities: DriftDiscontinuity[];
  /** Drift accumulated from the first capture call to the last, in ms. */
  totalDriftMs: number;
  /**
   * Slope of the drift curve in ms per minute. NaN when the segment is too
   * short to be meaningful, rather than a number extrapolated from noise.
   */
  driftMsPerMinute: number;
  /** Render calls that arrived before the first capture call. */
  leadingRenderFrames: number;
}

export interface DriftOptions {
  /**
   * Drift change within the detection window that counts as a discontinuity,
   * in ms. The default is two frames.
   */
  discontinuityThresholdMs?: number;
  /**
   * Capture frames the change is measured across. Defaults to a multiple of
   * the detected capture block size, which is what keeps block granularity out
   * of the result -- see analyzeCallOrder.
   *
   * Measuring across a window rather than between adjacent frames is what
   * separates a step from a slope. A gap spread over several frames shifts
   * drift by one frame at a time, so no single step is large, but the window
   * sees the whole shift. Steady clock drift moves far less within the same
   * window, so it does not trip the threshold.
   */
  discontinuityWindowFrames?: number;
  /** Smallest window to use when deriving one from the block size. */
  minimumWindowFrames?: number;
  /** Below this span the slope is not reported. */
  minimumSpanSeconds?: number;
}

/**
 * Analyses one segment's call order.
 *
 * Drift is sampled at each capture call, which makes capture time the x axis
 * and keeps the result aligned with the audio tracks and metadata series.
 */
export function analyzeCallOrder(
  segment: CallOrderSegment,
  {
    discontinuityThresholdMs = 2 * FRAME_MS,
    discontinuityWindowFrames,
    minimumWindowFrames = 5,
    minimumSpanSeconds = 1,
  }: DriftOptions = {}
): DriftAnalysis {
  const blocks = detectBlockStructure(segment.calls);
  const window = discontinuityWindowFrames ?? derivedWindow(blocks, minimumWindowFrames);

  const points: DriftPoint[] = [];

  let renderFrames = 0;
  let captureFrames = 0;
  let leadingRenderFrames = 0;
  let sawCapture = false;

  for (const call of segment.calls) {
    if (call === CALL_RENDER) {
      renderFrames++;
      if (!sawCapture) leadingRenderFrames++;
      continue;
    }
    if (call !== CALL_CAPTURE) continue;

    sawCapture = true;
    const captureFrame = segment.startFrame + captureFrames;
    captureFrames++;

    const driftFrames = renderFrames - captureFrames;
    const driftMs = driftFrames * FRAME_MS;
    points.push({
      captureFrame,
      time: (captureFrame * FRAME_MS) / 1000,
      renderFrames,
      driftFrames,
      driftMs,
    });
  }

  const discontinuities = findDiscontinuities(points, discontinuityThresholdMs, window);

  const first = points[0];
  const last = points[points.length - 1];
  const totalDriftMs = first && last ? last.driftMs - first.driftMs : 0;
  const spanSeconds = first && last ? last.time - first.time : 0;
  const driftMsPerMinute =
    spanSeconds >= minimumSpanSeconds ? (totalDriftMs / spanSeconds) * 60 : NaN;

  return {
    startFrame: segment.startFrame,
    blocks,
    discontinuityWindowFrames: window,
    points,
    discontinuities,
    totalDriftMs,
    driftMsPerMinute,
    leadingRenderFrames,
  };
}

/**
 * Window that whole delivery cycles fit into.
 *
 * The drift series is sampled once per capture call, and buffering makes it
 * sawtooth: render sits behind for the length of a capture block, then catches
 * up when a render block lands. The pattern repeats once both streams return
 * to the same phase, which takes a common multiple of the two block sizes --
 * not the capture block alone. With 40ms capture against 30ms render the cycle
 * is 12 capture frames, and a window of 8 straddles it and reads roughly every
 * cycle as a step.
 *
 * Spanning a whole number of cycles cancels the sawtooth exactly, leaving only
 * real movement.
 */
function derivedWindow(blocks: BlockStructure, minimumWindowFrames: number): number {
  const cycle = leastCommonMultiple(blocks.captureBlockFrames, blocks.renderBlockFrames);
  return cycle * Math.ceil(minimumWindowFrames / cycle);
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function leastCommonMultiple(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 1;
  return (a * b) / greatestCommonDivisor(a, b);
}

/**
 * Infers the delivery block size of each stream from runs in the call order.
 *
 * Uses the most common run length rather than the longest: a single odd run --
 * an extra render call where the clocks slipped, say -- should not redefine the
 * block size for the whole segment.
 */
export function detectBlockStructure(calls: Uint8Array): BlockStructure {
  const captureBlockFrames = modalRunLength(calls, CALL_CAPTURE);
  const renderBlockFrames = modalRunLength(calls, CALL_RENDER);
  return {
    captureBlockFrames,
    renderBlockFrames,
    captureBlockMs: captureBlockFrames * FRAME_MS,
    renderBlockMs: renderBlockFrames * FRAME_MS,
  };
}

function modalRunLength(calls: Uint8Array, call: number): number {
  const tally = new Map<number, number>();
  let run = 0;
  for (let i = 0; i <= calls.length; i++) {
    if (i < calls.length && calls[i] === call) {
      run++;
      continue;
    }
    if (run > 0) tally.set(run, (tally.get(run) ?? 0) + 1);
    run = 0;
  }

  let best = 1;
  let bestCount = 0;
  for (const [length, count] of tally) {
    // Ties go to the shorter run, which yields the smaller window.
    if (count > bestCount || (count === bestCount && length < best)) {
      best = length;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Finds where drift shifts sharply, measured across a window.
 *
 * A run of consecutive windows over the threshold describes one event, so they
 * collapse into a single entry reported at the window's start, carrying the
 * largest shift seen while the run lasted.
 */
function findDiscontinuities(
  points: DriftPoint[],
  thresholdMs: number,
  windowFrames: number
): DriftDiscontinuity[] {
  const discontinuities: DriftDiscontinuity[] = [];
  let open: DriftDiscontinuity | null = null;

  for (let i = windowFrames; i < points.length; i++) {
    const start = points[i - windowFrames];
    const stepMs = points[i].driftMs - start.driftMs;

    if (Math.abs(stepMs) < thresholdMs) {
      open = null;
      continue;
    }
    if (open && Math.sign(stepMs) === Math.sign(open.stepMs)) {
      // Same event still unfolding; keep the largest shift it reaches.
      if (Math.abs(stepMs) > Math.abs(open.stepMs)) open.stepMs = stepMs;
      continue;
    }

    // Report where drift actually starts moving, not where the window opened:
    // the window begins up to windowFrames before the event, and a marker that
    // seeks 50ms early points at the wrong place.
    let onset = points[i];
    for (let j = i - windowFrames + 1; j <= i; j++) {
      if (points[j].driftMs !== start.driftMs) {
        onset = points[j];
        break;
      }
    }
    open = { captureFrame: onset.captureFrame, time: onset.time, stepMs };
    discontinuities.push(open);
  }

  return discontinuities;
}

/** Analyses every segment of a dump. */
export function analyzeDrift(
  callOrder: CallOrderSegment[],
  options?: DriftOptions
): DriftAnalysis[] {
  return callOrder.map((segment) => analyzeCallOrder(segment, options));
}
