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
 *
 * This module reports the raw series and nothing else. It deliberately carries
 * no rate fit, discontinuity list, window selection or robust statistics: the
 * chart is the deliverable, and a human reading it classifies flat from sloped
 * from stepped far more reliably than a threshold can. Two properties of the
 * series make that a fair trade rather than laziness:
 *
 *   - Clustered delivery (`ccccrrrr`) makes the series sawtooth by exactly the
 *     run length. That is real information about the file, and every attempt to
 *     suppress it needed a window whose only justification was the estimator
 *     that consumed it.
 *   - Call order records when events were serialized, not when either clock
 *     ticked, so no figure derived from it is more precise than one frame.
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

export interface DriftAnalysis {
  startFrame: number;
  /** Capture calls in this segment. */
  captureFrameCount: number;
  /** Render calls in this segment. */
  renderFrameCount: number;
  /** One point per capture call, in order. */
  points: DriftPoint[];
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

/**
 * Analyses one segment's call order.
 *
 * Drift is sampled at each capture call, which makes capture time the x axis
 * and keeps the result aligned with the audio tracks and metadata series.
 */
export function analyzeCallOrder(segment: CallOrderSegment): DriftAnalysis {
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
    points.push({
      captureFrame,
      time: (captureFrame * FRAME_MS) / 1000,
      renderFrames,
      driftFrames,
      driftMs: driftFrames * FRAME_MS,
    });
  }

  return {
    startFrame: segment.startFrame,
    captureFrameCount: captureFrames,
    renderFrameCount: renderFrames,
    points,
    leadingRenderFrames,
    trailingRenderFrames: renderFrames - renderFramesAtLastCapture,
  };
}

/** Analyses every segment of a dump. */
export function analyzeDrift(callOrder: CallOrderSegment[]): DriftAnalysis[] {
  return callOrder.map(analyzeCallOrder);
}
