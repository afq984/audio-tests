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
  /** Capture frame where drift starts moving. */
  captureFrame: number;
  time: number;
  /**
   * Capture frame where drift stops moving.
   *
   * A step is not instantaneous: a 500ms render gap moves drift one frame at a
   * time across 50 capture frames. Knowing the extent, not just the onset, is
   * what lets the rate fit exclude the whole transition rather than a fixed
   * window's worth of it.
   */
  endFrame: number;
  endTime: number;
  /** Change in drift across the transition, in ms. Negative is a render gap. */
  stepMs: number;
}

/**
 * How calls of each kind cluster in the file.
 *
 * APM always processes 10ms frames, but consecutive calls of one kind appear
 * as runs (`ccccrrrr`) -- and that pattern has to be measured before drift can
 * be, because run granularity looks exactly like drift if you sample naively.
 *
 * This is deliberately NOT called a block or buffer size. A run of four
 * capture calls does not prove a 40ms capture callback: they may simply have
 * accumulated between render callbacks. Call order records the order events
 * were serialized, so run length is a lower bound on clustering and nothing
 * more. Treat it as an input to the windowing rule, not as a fact about the
 * audio stack to show a user.
 *
 * A run length is null when that stream made no calls at all -- unknown rather
 * than one frame.
 */
export interface RunStructure {
  /** Most common length of a consecutive capture run, or null if none. */
  captureRunFrames: number | null;
  /** Most common length of a consecutive render run, or null if none. */
  renderRunFrames: number | null;
}

export interface DriftAnalysis {
  startFrame: number;
  runs: RunStructure;
  /** Capture frames the discontinuity window actually spanned. */
  discontinuityWindowFrames: number;
  /** One point per capture call, in order. */
  points: DriftPoint[];
  discontinuities: DriftDiscontinuity[];
  /**
   * Difference between the first and last sampled drift, in ms.
   *
   * Phase-sensitive: run clustering makes drift sawtooth, so where the first
   * and last samples fall within a cycle shifts this by up to one cycle. Use
   * driftMsPerMinute for the actual rate; this is the raw observation.
   */
  endpointDriftMs: number;
  /**
   * Rate of drift in ms per minute, from a least-squares fit over every
   * sample rather than the endpoints.
   *
   * Regression is insensitive to run phase -- the sawtooth is zero-mean around
   * the trend -- so healthy clustered delivery reports ~0 instead of the
   * endpoint artefact. NaN when the segment is too short to be meaningful,
   * rather than a number extrapolated from noise.
   */
  driftMsPerMinute: number;
  /** Render calls that arrived before the first capture call. */
  leadingRenderFrames: number;
  /**
   * Render calls after the last capture call.
   *
   * Drift is sampled at capture calls, so these are never represented in
   * `points`: `crcrrrrr` and `crcr` produce identical series. A non-zero value
   * here means there was render activity the analysis could not observe.
   */
  trailingRenderFrames: number;
}

export interface DriftOptions {
  /**
   * Drift change within the detection window that counts as a discontinuity,
   * in ms. The default is two frames.
   */
  discontinuityThresholdMs?: number;
  /**
   * Capture frames the change is measured across. Defaults to a whole number
   * of delivery cycles, which is what keeps run granularity out of the result
   * -- see derivedWindow.
   *
   * Measuring across a window rather than between adjacent frames is what
   * separates a step from a slope. A gap spread over several frames shifts
   * drift by one frame at a time, so no single step is large, but the window
   * sees the whole shift. Steady clock drift moves far less within the same
   * window, so it does not trip the threshold.
   */
  discontinuityWindowFrames?: number;
  /** Smallest window to use when deriving one from the run structure. */
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
  const runs = detectRunStructure(segment.calls);
  const window = discontinuityWindowFrames ?? derivedWindow(runs, minimumWindowFrames);

  const points: DriftPoint[] = [];

  let renderFrames = 0;
  let captureFrames = 0;
  let leadingRenderFrames = 0;
  let renderFramesAtLastCapture = 0;
  let sawCapture = false;

  for (const call of segment.calls) {
    if (call === CALL_RENDER) {
      renderFrames++;
      if (!sawCapture) leadingRenderFrames++;
      continue;
    }
    if (call !== CALL_CAPTURE) continue;

    sawCapture = true;
    renderFramesAtLastCapture = renderFrames;
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
  const endpointDriftMs = first && last ? last.driftMs - first.driftMs : 0;
  const spanSeconds = first && last ? last.time - first.time : 0;
  const driftMsPerMinute =
    spanSeconds >= minimumSpanSeconds
      ? fitRateMsPerMinute(points, discontinuities, window, minimumSpanSeconds)
      : NaN;

  return {
    startFrame: segment.startFrame,
    runs,
    discontinuityWindowFrames: window,
    points,
    discontinuities,
    endpointDriftMs,
    driftMsPerMinute,
    leadingRenderFrames,
    trailingRenderFrames: renderFrames - renderFramesAtLastCapture,
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
function derivedWindow(runs: RunStructure, minimumWindowFrames: number): number {
  const cycle = leastCommonMultiple(runs.captureRunFrames ?? 1, runs.renderRunFrames ?? 1);
  return cycle * Math.ceil(minimumWindowFrames / cycle);
}

/**
 * Drift rate in ms per minute, fitted within spans rather than across them.
 *
 * A least-squares fit over the whole segment handles run clustering well --
 * the sawtooth is zero-mean around the trend, so it cancels -- but not a step.
 * A discontinuity shifts every later sample by a constant, which tilts a
 * single global line: a 500ms gap in the middle of an otherwise drift-free
 * segment fits at -744ms/min when the true rate is zero.
 *
 * The steps are already known, so cut the series at them, fit each clean span,
 * and combine those slopes weighted by duration. Each span is an unbiased
 * local estimate and a step between spans no longer enters any fit. Spans too
 * short to be meaningful are skipped rather than allowed to dominate.
 */
function fitRateMsPerMinute(
  points: DriftPoint[],
  discontinuities: DriftDiscontinuity[],
  windowFrames: number,
  minimumSpanSeconds: number
): number {
  const spans = cleanSpans(points, discontinuities, windowFrames);

  let weighted = 0;
  let totalWeight = 0;
  for (const span of spans) {
    const seconds = span[span.length - 1].time - span[0].time;
    if (seconds < minimumSpanSeconds) continue;
    const slope = regressionSlopeMsPerSecond(span);
    if (!Number.isFinite(slope)) continue;
    weighted += slope * seconds;
    totalWeight += seconds;
  }
  // Every span was too short to fit -- typically one long segment cut up by
  // frequent steps. Say nothing rather than report a number from fragments.
  if (totalWeight === 0) return NaN;
  return (weighted / totalWeight) * 60;
}

/**
 * Splits the series at discontinuities, dropping the transition itself.
 *
 * A step takes up to `windowFrames` to complete, so the samples spanning it
 * belong to neither side and are excluded from both.
 */
function cleanSpans(
  points: DriftPoint[],
  discontinuities: readonly DriftDiscontinuity[],
  windowFrames: number
): DriftPoint[][] {
  if (discontinuities.length === 0) return points.length > 0 ? [points] : [];

  const spans: DriftPoint[][] = [];
  let start = 0;
  for (const discontinuity of discontinuities) {
    const onset = points.findIndex((p) => p.captureFrame >= discontinuity.captureFrame);
    const end = points.findIndex((p) => p.captureFrame > discontinuity.endFrame);
    if (onset < 0) continue;
    if (onset > start) spans.push(points.slice(start, onset));
    // Skip the whole transition, which the discontinuity's extent describes,
    // plus the trailing window whose measurements still straddle it.
    const resume = end < 0 ? points.length : end + windowFrames;
    start = Math.max(start, resume);
  }
  if (start < points.length) spans.push(points.slice(start));
  return spans.filter((span) => span.length >= 2);
}

/** Least-squares slope of drift against time, in ms per second. */
function regressionSlopeMsPerSecond(points: DriftPoint[]): number {
  if (points.length < 2) return NaN;
  let sumT = 0;
  let sumD = 0;
  for (const point of points) {
    sumT += point.time;
    sumD += point.driftMs;
  }
  const meanT = sumT / points.length;
  const meanD = sumD / points.length;

  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dt = point.time - meanT;
    covariance += dt * (point.driftMs - meanD);
    variance += dt * dt;
  }
  return variance === 0 ? NaN : covariance / variance;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function leastCommonMultiple(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 1;
  return (a * b) / greatestCommonDivisor(a, b);
}

/**
 * Infers how calls of each kind cluster, from runs in the call order.
 *
 * Uses the most common run length rather than the longest: a single odd run --
 * an extra render call where the clocks slipped, say -- should not redefine the
 * pattern for the whole segment.
 */
export function detectRunStructure(calls: Uint8Array): RunStructure {
  return {
    captureRunFrames: modalRunLength(calls, CALL_CAPTURE),
    renderRunFrames: modalRunLength(calls, CALL_RENDER),
  };
}

function modalRunLength(calls: Uint8Array, call: number): number | null {
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

  if (tally.size === 0) return null;
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
      if (open) {
        // The window no longer spans a large change, so the transition
        // finished at or before this window's start.
        open.endFrame = start.captureFrame;
        open.endTime = start.time;
      }
      open = null;
      continue;
    }
    if (open && Math.sign(stepMs) === Math.sign(open.stepMs)) {
      // Same event still unfolding; keep the largest shift it reaches.
      if (Math.abs(stepMs) > Math.abs(open.stepMs)) open.stepMs = stepMs;
      open.endFrame = points[i].captureFrame;
      open.endTime = points[i].time;
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
    open = {
      captureFrame: onset.captureFrame,
      time: onset.time,
      // Provisional: extended as the transition unfolds, closed when the
      // window stops seeing a large change.
      endFrame: points[i].captureFrame,
      endTime: points[i].time,
      stepMs,
    };
    discontinuities.push(open);
  }

  // A transition still open at the end of the series ends with the series.
  if (open && points.length > 0) {
    const last = points[points.length - 1];
    open.endFrame = last.captureFrame;
    open.endTime = last.time;
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
