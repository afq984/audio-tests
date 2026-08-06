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
