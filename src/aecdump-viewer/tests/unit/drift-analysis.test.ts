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
    expect(result.endpointDriftMs).toBe(0);
    expect(result.discontinuities).toEqual([]);
    expect(result.driftMsPerMinute).toBe(0);
  });

  it('withholds the slope for a span under a second', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 100)));
    // 100 frames is 0.99s between first and last sample.
    expect(result.driftMsPerMinute).toBeNaN();
    expect(result.endpointDriftMs).toBe(0);
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
    // One extra render call per 10 captures: 10ms gained per 100ms, so the
    // truth is 6000ms per minute.
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'r', 60)));
    expect(result.points).toHaveLength(600);
    expect(result.driftMsPerMinute).toBeCloseTo(6000, -2);

    // The endpoint difference lands ~90ms/min short of that, because the first
    // and last samples sit at different phases of the run cycle. That gap is
    // exactly why the rate comes from a fit rather than the endpoints.
    expect(result.endpointDriftMs).toBeCloseTo(590, 9);
    expect((result.endpointDriftMs / 5.99) * 60).toBeCloseTo(5909.85, 1);
  });

  it('does not mistake a steady slope for a discontinuity', () => {
    // Drift climbs one frame per ten, far less than the threshold across the
    // five-frame detection window.
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'r', 60)));
    expect(result.discontinuities).toEqual([]);
  });

  it('reports a negative slope when capture outpaces render', () => {
    const result = analyzeCallOrder(callOrder(repeat(repeat('rc', 10) + 'c', 60)));
    expect(result.endpointDriftMs).toBeLessThan(0);
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
    expect(result.endpointDriftMs).toBeCloseTo(-50, 9);
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
    expect(result.endpointDriftMs).toBe(0);
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
    expect(result.runs.captureRunFrames).toBe(4);
    expect(result.runs.renderRunFrames).toBe(4);
    expect(result.runs.renderRunFrames).toBe(4);
  });

  it('reports one-frame blocks for a lockstep segment', () => {
    const result = analyzeCallOrder(callOrder(repeat('rc', 100)));
    expect(result.runs).toEqual({ captureRunFrames: 1, renderRunFrames: 1 });
  });

  it('ignores a single odd run when inferring the block size', () => {
    // One five-call render run among fours must not redefine the block size.
    let calls = '';
    for (let i = 0; i < 100; i++) calls += i === 50 ? 'ccccrrrrr' : 'ccccrrrr';
    expect(analyzeCallOrder(callOrder(calls)).runs.renderRunFrames).toBe(4);
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
    expect(result.discontinuityWindowFrames % result.runs.captureRunFrames!).toBe(0);
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
    const { captureRunFrames, renderRunFrames } = result.runs;
    expect(result.discontinuityWindowFrames % captureRunFrames!).toBe(0);
    expect(result.discontinuityWindowFrames % renderRunFrames!).toBe(0);
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

describe('honest reporting', () => {
  it('reports run structure as unknown for a stream that never called', () => {
    expect(analyzeCallOrder(callOrder(repeat('c', 20))).runs).toEqual({
      captureRunFrames: 20,
      renderRunFrames: null,
    });
    expect(analyzeCallOrder(callOrder(repeat('r', 20))).runs).toEqual({
      captureRunFrames: null,
      renderRunFrames: 20,
    });
  });

  it('counts render calls the drift series could not observe', () => {
    // crcrrrrr and crcr produce identical drift points, because drift is only
    // sampled at capture calls. The count is what distinguishes them.
    const observed = analyzeCallOrder(callOrder('crc'));
    const withTail = analyzeCallOrder(callOrder('crcrrrr'));
    expect(withTail.points.map((p) => p.driftMs)).toEqual(observed.points.map((p) => p.driftMs));
    expect(observed.trailingRenderFrames).toBe(0);
    expect(withTail.trailingRenderFrames).toBe(4);
  });

  it('reports zero drift rate for healthy clustered delivery', () => {
    // The endpoint difference is a phase artefact; the fitted rate is not.
    const result = analyzeCallOrder(callOrder(repeat('ccccrrrr', 750)));
    expect(result.endpointDriftMs).toBeCloseTo(-30, 9);
    expect(Math.abs(result.driftMsPerMinute)).toBeLessThan(1);
  });

  it('reports zero drift rate for mismatched-run delivery too', () => {
    const result = analyzeCallOrder(mismatchedBlocks(4, 3, 30));
    expect(Math.abs(result.driftMsPerMinute)).toBeLessThan(1);
  });

  it('still measures a genuine drift rate', () => {
    let calls = '';
    for (let i = 0; i < 750; i++) calls += i % 25 === 0 ? 'ccccrrrrr' : 'ccccrrrr';
    const result = analyzeCallOrder(callOrder(calls));
    // One extra render frame per 25 blocks of 4 capture frames: 600ms/min.
    expect(result.driftMsPerMinute).toBeCloseTo(600, -2);
  });
});

describe('drift rate around discontinuities', () => {
  it('is not tilted by a step in the middle of a drift-free segment', () => {
    // 30s lockstep, a 500ms render gap, 30s lockstep. Both halves are in
    // lockstep, so the true rate is zero; a single global fit reads -744.
    const result = analyzeCallOrder(
      callOrder(repeat('rc', 3000) + repeat('c', 50) + repeat('rc', 3000))
    );
    expect(result.discontinuities).toHaveLength(1);
    expect(Math.abs(result.driftMsPerMinute)).toBeLessThan(0.5);
    // The step itself is still reported; it just does not become a rate. Its
    // extent covers the transition, not only the instant it began.
    expect(result.endpointDriftMs).toBeCloseTo(-500, 9);
    expect(result.discontinuities[0].endFrame).toBeGreaterThan(
      result.discontinuities[0].captureFrame
    );
  });

  it('is not tilted by a step near the start', () => {
    const result = analyzeCallOrder(
      callOrder(repeat('rc', 300) + repeat('c', 50) + repeat('rc', 5700))
    );
    expect(Math.abs(result.driftMsPerMinute)).toBeLessThan(0.5);
  });

  it('still measures drift that continues across a step', () => {
    // Genuine 6000ms/min drift throughout, interrupted by one gap.
    const drifting = repeat(repeat('rc', 10) + 'r', 300);
    const result = analyzeCallOrder(callOrder(drifting + repeat('c', 50) + drifting));
    expect(result.driftMsPerMinute).toBeCloseTo(6000, -2);
  });

  it('reports nothing when steps leave no span long enough to fit', () => {
    // A gap every half second: no clean span reaches the one-second floor.
    let calls = '';
    for (let i = 0; i < 40; i++) calls += repeat('rc', 50) + repeat('c', 30);
    expect(analyzeCallOrder(callOrder(calls)).driftMsPerMinute).toBeNaN();
  });
});
