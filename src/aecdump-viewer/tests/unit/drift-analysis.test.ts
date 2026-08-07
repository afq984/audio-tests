import { describe, it, expect } from 'vitest';
import { analyzeCallOrder, analyzeDrift } from '../../src/drift-analysis.js';
import { CallOrderSegment } from '../../src/dump-model.js';

/** Builds a call-order segment from a literal 'rcrc...' string. */
function callOrder(calls: string, startFrame = 0): CallOrderSegment {
  return { startFrame, calls: Uint8Array.from(calls, (c) => c.charCodeAt(0)) };
}

/** Repeats a pattern n times. */
const repeat = (pattern: string, n: number) => pattern.repeat(n);

describe('lockstep', () => {
  it('reports zero drift when render and capture alternate', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 200)));
    expect(result.points).toHaveLength(200);
    expect(result.points.every((p) => p.driftMs === 0)).toBe(true);
    expect(result.captureFrameCount).toBe(200);
    expect(result.renderFrameCount).toBe(200);
  });

  it('samples once per capture call and uses capture time as the x axis', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 5)));
    expect(result.points.map((p) => p.captureFrame)).toEqual([0, 1, 2, 3, 4]);
    expect(result.points.map((p) => p.time)).toEqual([0, 0.01, 0.02, 0.03, 0.04]);
  });

  it('offsets frames by the segment start', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 3), 1200));
    expect(result.points.map((p) => p.captureFrame)).toEqual([1200, 1201, 1202]);
    expect(result.points[0].time).toBeCloseTo(12.0, 9);
  });
});

describe('clustered delivery', () => {
  it('sawtooths by the run length rather than reporting a trend', () => {
    // ccccrrrr repeated. Drift is sampled only at capture calls, so the render
    // run that catches up is never observed mid-run: every sample lands during
    // a capture run and the series repeats -1,-2,-3,-4. The sawtooth amplitude
    // is the capture run length. It is a fact about the file, not noise to be
    // smoothed away.
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 10)));
    const drifts = result.points.slice(0, 8).map((p) => p.driftFrames);
    expect(drifts).toEqual([-1, -2, -3, -4, -1, -2, -3, -4]);
    expect(result.captureFrameCount).toBe(40);
    expect(result.renderFrameCount).toBe(40);
  });

  it('holds a bounded sawtooth when both streams deliver the same amount', () => {
    // No trend: 750 cycles later the series is still oscillating over the same
    // four frames rather than walking away.
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 750)));
    expect(result.captureFrameCount).toBe(result.renderFrameCount);
    expect(result.points[result.points.length - 1].driftFrames).toBe(-4);
    expect(Math.min(...result.points.map((p) => p.driftFrames))).toBe(-4);
    expect(Math.max(...result.points.map((p) => p.driftFrames))).toBe(-1);
  });

  it('tracks a genuine rate mismatch as an accumulating deficit', () => {
    // Not a callback-size mismatch -- 40ms capture against 30ms render still
    // yields equal call counts over their common cycle. Four capture calls
    // against three render calls forever is a persistent 25% render deficit,
    // so drift walks steadily negative instead of oscillating.
    const result = analyzeCallOrder(callOrder(repeat('ccccrrr', 100)));
    expect(result.captureFrameCount).toBe(400);
    expect(result.renderFrameCount).toBe(300);
    // 400th capture call, preceded by 3 x 99 render calls.
    expect(result.points[result.points.length - 1].driftFrames).toBe(-103);
  });
});

describe('jitter', () => {
  it('records serialization wobble without inventing a defect', () => {
    // crrccr: two render calls inside one capture interval. Drift moves off
    // zero and back within a couple of frames; nothing happened to the audio,
    // and the trailing render call is invisible to the series.
    const result = analyzeCallOrder(callOrder('crrccr'));
    expect(result.points.map((p) => p.driftFrames)).toEqual([-1, 0, -1]);
    expect(result.trailingRenderFrames).toBe(1);
  });
});

describe('steps', () => {
  it('shows a render gap as a downward walk in the series', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 20) + repeat('c', 50) + repeat('rc', 20)));
    const drifts = result.points.map((p) => p.driftFrames);
    expect(drifts.slice(0, 20).every((d) => d === 0)).toBe(true);
    expect(drifts[69]).toBe(-50);
    expect(drifts[drifts.length - 1]).toBe(-50);
  });

  it('shows a render burst as an upward step', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 20) + repeat('r', 30) + repeat('rc', 20)));
    expect(result.points[20].driftFrames).toBe(30);
    expect(result.points[result.points.length - 1].driftFrames).toBe(30);
  });
});

describe('edges', () => {
  it('counts render calls before the first capture call', () => {
    const result = analyzeCallOrder(callOrder('rrr' + repeat('rc', 10)));
    expect(result.leadingRenderFrames).toBe(4);
    expect(result.points[0].driftFrames).toBe(3);
  });

  it('counts a render-only segment as entirely leading', () => {
    const result = analyzeCallOrder(callOrder('rrrr'));
    expect(result.leadingRenderFrames).toBe(4);
    expect(result.renderFrameCount).toBe(4);
    expect(result.points).toEqual([]);
    expect(result.trailingRenderFrames).toBe(4);
  });

  it('counts render calls after the last capture call, which no point shows', () => {
    const observed = analyzeCallOrder(callOrder('crc'));
    const withTail = analyzeCallOrder(callOrder('crcrrrr'));
    expect(withTail.points).toEqual(observed.points);
    expect(withTail.trailingRenderFrames).toBe(4);
    expect(observed.trailingRenderFrames).toBe(0);
  });

  it('handles an empty segment', () => {
    const result = analyzeCallOrder(callOrder(''));
    expect(result.points).toEqual([]);
    expect(result.captureFrameCount).toBe(0);
    expect(result.renderFrameCount).toBe(0);
    expect(result.leadingRenderFrames).toBe(0);
    expect(result.trailingRenderFrames).toBe(0);
  });

  it('walks drift negative through a capture-only segment', () => {
    const result = analyzeCallOrder(callOrder(repeat('c', 200)));
    expect(result.points[199].driftFrames).toBe(-200);
    expect(result.renderFrameCount).toBe(0);
  });

  it('ignores characters that are neither r nor c', () => {
    const result = analyzeCallOrder(callOrder('c?r!c'));
    expect(result.captureFrameCount).toBe(2);
    expect(result.renderFrameCount).toBe(1);
  });
});

describe('analyzeDrift', () => {
  it('analyses each segment against its own start frame', () => {
    const results = analyzeDrift([
      callOrder(repeat('rc', 5), 0),
      callOrder(repeat('rc', 5), 1200),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].startFrame).toBe(0);
    expect(results[1].startFrame).toBe(1200);
    expect(results[1].points[0].captureFrame).toBe(1200);
  });
});
