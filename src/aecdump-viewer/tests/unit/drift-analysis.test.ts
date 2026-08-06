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
    // 200 frames spans 1.99s, past the one-second floor for reporting a slope.
    const result = analyzeCallOrder(callOrder(repeat('rc', 200)));
    expect(result.points).toHaveLength(200);
    expect(result.points.every((p) => p.driftMs === 0)).toBe(true);
    expect(result.totalDriftMs).toBe(0);
    expect(result.discontinuities).toEqual([]);
    expect(result.driftMsPerMinute).toBe(0);
  });

  it('withholds the slope for a span under a second', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 100)));
    // 100 frames is 0.99s between first and last sample.
    expect(result.driftMsPerMinute).toBeNaN();
    expect(result.totalDriftMs).toBe(0);
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

describe('clock drift', () => {
  it('reports a positive slope when render outpaces capture', () => {
    // One extra render call per 10 captures. After group k the last capture
    // sees render = 11k-1 against capture = 10k, so drift is (k-1) frames:
    // 0 at the first sample and 59 frames (590ms) at the last, over 5.99s.
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'r', 60)));
    expect(result.points).toHaveLength(600);
    expect(result.totalDriftMs).toBeCloseTo(590, 9);
    expect(result.driftMsPerMinute).toBeCloseTo((590 / 5.99) * 60, 6);
  });

  it('does not mistake a steady slope for a discontinuity', () => {
    // Drift climbs one frame per ten, far less than the threshold across the
    // five-frame detection window.
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'r', 60)));
    expect(result.discontinuities).toEqual([]);
  });

  it('reports a negative slope when capture outpaces render', () => {
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'c', 60)));
    expect(result.totalDriftMs).toBeLessThan(0);
    expect(result.driftMsPerMinute).toBeLessThan(0);
  });

  it('does not report a slope for a segment too short to mean anything', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 20)));
    // 20 frames is 200ms, below the one-second floor.
    expect(result.driftMsPerMinute).toBeNaN();
  });
});

describe('discontinuities', () => {
  it('flags a render gap as a single downward step', () => {
    // 50 in lockstep, then 5 capture calls with no render, then lockstep again.
    // No adjacent pair of frames differs by more than one frame, so only the
    // windowed measurement sees the 50ms shift.
    const result = analyzeCallOrder(
      callOrder(repeat('rc', 50) + repeat('c', 5) + repeat('rc', 50))
    );
    expect(result.discontinuities).toHaveLength(1);
    expect(result.discontinuities[0].stepMs).toBeCloseTo(-50, 9);
    // Reported where drift starts moving, which is the first capture frame of
    // the gap, not where the detection window happened to open.
    expect(result.discontinuities[0].captureFrame).toBe(50);
    expect(result.totalDriftMs).toBeCloseTo(-50, 9);
  });

  it('flags a burst of render calls as an upward step', () => {
    const result = analyzeCallOrder(repeatBurst());
    expect(result.discontinuities).toHaveLength(1);
    expect(result.discontinuities[0].stepMs).toBeCloseTo(50, 9);
    expect(result.discontinuities[0].captureFrame).toBe(50);
  });

  it('ignores single-frame jitter by default', () => {
    // One extra render call, then one extra capture call: never two frames off.
    const result = analyzeCallOrder(callOrder(repeat('rc', 20) + 'rrc' + repeat('rc', 20)));
    expect(result.discontinuities).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const calls = callOrder(repeat('rc', 20) + 'rrc' + repeat('rc', 20));
    expect(analyzeCallOrder(calls, { discontinuityThresholdMs: 10 }).discontinuities).toHaveLength(
      1
    );
  });
});

/** 50 lockstep pairs, then six render calls at once, then more lockstep. */
function repeatBurst(): CallOrderSegment {
  return callOrder(repeat('rc', 50) + repeat('r', 5) + repeat('rc', 50));
}

describe('edges', () => {
  it('counts render calls that precede the first capture call', () => {
    // 'rrr' plus the leading 'r' of the first pair: four render calls land
    // before any capture call.
    const result = analyzeCallOrder(callOrder('rrr' + repeat('rc', 10)));
    expect(result.leadingRenderFrames).toBe(4);
    expect(result.points[0].driftMs).toBeCloseTo(30, 9);
  });

  it('handles a segment with no capture calls', () => {
    const result = analyzeCallOrder(callOrder('rrrr'));
    expect(result.points).toEqual([]);
    expect(result.totalDriftMs).toBe(0);
    expect(result.driftMsPerMinute).toBeNaN();
    expect(result.leadingRenderFrames).toBe(4);
  });

  it('handles an empty segment', () => {
    const result = analyzeCallOrder(callOrder(''));
    expect(result.points).toEqual([]);
    expect(result.discontinuities).toEqual([]);
  });

  it('reports a capture-only segment as steadily falling behind', () => {
    const result = analyzeCallOrder(callOrder(repeat('c', 200)));
    expect(result.points).toHaveLength(200);
    // No render at all: drift decreases by one frame per capture frame.
    expect(result.points[199].driftMs).toBeCloseTo(-2000, 9);
    expect(result.driftMsPerMinute).toBeCloseTo(-60000, -3);
  });
});

describe('analyzeDrift', () => {
  it('analyses each segment independently', () => {
    const results = analyzeDrift([
      callOrder(repeat('rc', 10), 0),
      callOrder(repeat('rc', 5), 10),
    ]);
    expect(results.map((r) => r.startFrame)).toEqual([0, 10]);
    expect(results[1].points[0].captureFrame).toBe(10);
  });
});

describe('delivery block structure', () => {
  it('detects 10ms capture against 40ms render', () => {
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 750)));
    expect(result.blocks.captureBlockFrames).toBe(4);
    expect(result.blocks.renderBlockFrames).toBe(4);
    expect(result.blocks.renderBlockMs).toBe(40);
  });

  it('reports one-frame blocks for a lockstep segment', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 100)));
    expect(result.blocks).toMatchObject({
      captureBlockFrames: 1,
      renderBlockFrames: 1,
      captureBlockMs: 10,
      renderBlockMs: 10,
    });
  });

  it('ignores a single odd run when inferring the block size', () => {
    // One five-call render run among fours must not redefine the block size.
    let calls = '';
    for (let i = 0; i < 100; i++) calls += i === 50 ? 'ccccrrrrr' : 'ccccrrrr';
    expect(analyzeCallOrder(callOrder(calls)).blocks.renderBlockFrames).toBe(4);
  });
});

describe('block granularity is not drift', () => {
  it('reports no discontinuities for healthy block-mismatched audio', () => {
    // 30s of 10ms capture against 40ms render, no clock drift at all. Drift
    // sawtooths between -10ms and -40ms purely from buffering; a window that
    // does not span whole periods reads every cycle as a step.
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 750)));
    expect(result.discontinuities).toEqual([]);
  });

  it('derives a window that spans whole capture blocks', () => {
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 750)));
    expect(result.discontinuityWindowFrames % result.blocks.captureBlockFrames).toBe(0);
    expect(result.discontinuityWindowFrames).toBeGreaterThanOrEqual(4);
  });

  it('still sees genuine drift underneath the block pattern', () => {
    // An extra render frame every 25 blocks: real drift of ~600ms per minute.
    let calls = '';
    for (let i = 0; i < 750; i++) calls += i % 25 === 0 ? 'ccccrrrrr' : 'ccccrrrr';
    const result = analyzeCallOrder(callOrder(calls));
    expect(result.driftMsPerMinute).toBeGreaterThan(400);
    // Gradual drift is a slope, not a sequence of steps.
    expect(result.discontinuities).toEqual([]);
  });

  it('still catches a real gap in block-mismatched audio', () => {
    // Same block structure, but render stops for two whole blocks.
    const result = analyzeCallOrder(
      callOrder(repeat('ccccrrrr', 100) + repeat('cccc', 2) + repeat('ccccrrrr', 100))
    );
    expect(result.discontinuities.length).toBeGreaterThan(0);
    expect(result.discontinuities.every((d) => d.stepMs < 0)).toBe(true);
  });

  it('keeps the lockstep window at the previous default', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 100)));
    expect(result.discontinuityWindowFrames).toBe(5);
  });
});

/** Healthy stream: capture blocks of cb frames against render blocks of rb, equal rates. */
function mismatchedBlocks(cb: number, rb: number, seconds: number): CallOrderSegment {
  const events: Array<[number, string]> = [];
  for (let t = 0; t < seconds * 1000; t += cb * 10) events.push([t, 'c'.repeat(cb)]);
  for (let t = 0; t < seconds * 1000; t += rb * 10) events.push([t + 0.5, 'r'.repeat(rb)]);
  events.sort((a, b) => a[0] - b[0]);
  return callOrder(events.map((e) => e[1]).join(''));
}

describe('mismatched block sizes', () => {
  // The delivery cycle repeats once both streams return to the same phase,
  // which takes a common multiple of the two block sizes -- not the capture
  // block alone. A window aligned only to capture straddles the cycle.
  it.each([
    [1, 1],
    [1, 4],
    [4, 1],
    [2, 3],
    [4, 3],
    [3, 5],
    [2, 5],
  ])('reports no discontinuities for healthy %i/%i block delivery', (cb, rb) => {
    expect(analyzeCallOrder(mismatchedBlocks(cb, rb, 30)).discontinuities).toEqual([]);
  });

  it('spans whole delivery cycles', () => {
    const result = analyzeCallOrder(mismatchedBlocks(4, 3, 30));
    const { captureBlockFrames, renderBlockFrames } = result.blocks;
    expect(result.discontinuityWindowFrames % captureBlockFrames).toBe(0);
    expect(result.discontinuityWindowFrames % renderBlockFrames).toBe(0);
  });

  it('still catches a real gap under mismatched blocks', () => {
    const healthy = mismatchedBlocks(4, 3, 15);
    const text = String.fromCharCode(...healthy.calls);
    const half = Math.floor(text.length / 2);
    // Drop a full second of render calls in the middle.
    const withGap = callOrder(text.slice(0, half) + 'c'.repeat(100) + text.slice(half));
    const result = analyzeCallOrder(withGap);
    expect(result.discontinuities.length).toBeGreaterThan(0);
    expect(result.discontinuities.some((d) => d.stepMs < -100)).toBe(true);
  });
});
