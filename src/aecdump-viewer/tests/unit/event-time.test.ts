import { describe, it, expect } from 'vitest';
import { CallOrderSegment } from '../../src/dump-model.js';
import {
  DEFAULT_ALLOWED_LATENESS_FRAMES,
  EventTimeLayout,
  EventTimeRun,
  layOutEventTime,
  runsFor,
  toEventFrame,
  toNativeFrame,
} from '../../src/event-time.js';

/** One segment from a literal 'rcrc...' string. */
const calls = (s: string, startFrame = 0): CallOrderSegment[] => [
  { startFrame, calls: Uint8Array.from(s, (c) => c.charCodeAt(0)) },
];
const repeat = (pattern: string, n: number) => pattern.repeat(n);

/**
 * Interleaves two callback streams by delivery time, each callback handing APM
 * one 10ms call per 10ms of its buffer. Render is written near the start of
 * reverse processing and capture after capture processing finishes, so render
 * takes a tie.
 */
function scheduled(captureMs: number, renderMs: number, durationMs: number): string {
  const events: Array<[number, number, string]> = [];
  for (let t = renderMs; t <= durationMs; t += renderMs) {
    events.push([t, 0, 'r'.repeat(renderMs / 10)]);
  }
  for (let t = captureMs; t <= durationMs; t += captureMs) {
    events.push([t, 1, 'c'.repeat(captureMs / 10)]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return events.map(([, , s]) => s).join('');
}

/** Slot occupied by each native frame of a lane, in order. */
function slots(layout: EventTimeLayout, stream: 'capture' | 'render'): number[] {
  const out: number[] = [];
  for (const run of runsFor(layout, stream)) {
    for (let i = 0; i < run.frameCount; i++) out.push(run.eventStartFrame + i);
  }
  return out;
}

function frameCount(runs: EventTimeRun[]): number {
  return runs.reduce((total, run) => total + run.frameCount, 0);
}

describe('lockstep', () => {
  it('leaves both lanes dense and aligned by ordinal frame', () => {
    const layout = layOutEventTime(calls(repeat('rc', 100)));
    expect(layout.captureRuns).toEqual([
      { nativeStartFrame: 0, eventStartFrame: 0, frameCount: 100 },
    ]);
    expect(layout.renderRuns).toEqual([
      { nativeStartFrame: 0, eventStartFrame: 0, frameCount: 100 },
    ]);
    expect(layout.gaps).toEqual([]);
    expect(layout.extentFrames).toBe(100);
  });
});

describe('clustered delivery', () => {
  it('backfills ccccrrrr into the same slots, with no gap', () => {
    const layout = layOutEventTime(calls(repeat('ccccrrrr', 50)));
    expect(layout.gaps).toEqual([]);
    expect(layout.captureRuns).toHaveLength(1);
    expect(layout.renderRuns).toHaveLength(1);
    expect(layout.extentFrames).toBe(200);
    expect(slots(layout, 'render').slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('backfills at a lag of exactly the tolerance', () => {
    // Four capture calls put the frontier at 4; the first render call sees a
    // lag of exactly 4 and is still allowed to backfill.
    const layout = layOutEventTime(calls('ccccrrrr'), 4);
    expect(layout.gaps).toEqual([]);
    expect(slots(layout, 'render')).toEqual([0, 1, 2, 3]);
  });

  it('rebases at a lag one frame past the tolerance', () => {
    const layout = layOutEventTime(calls('ccccrrrr'), 3);
    expect(layout.gaps).toEqual([
      {
        stream: 'render',
        eventStartFrame: 0,
        eventEndFrame: 4,
        nextNativeFrame: 0,
        observedLagFrames: 4,
      },
    ]);
    expect(slots(layout, 'render')).toEqual([4, 5, 6, 7]);
  });

  it('degrades to alternating gaps in both lanes when the tolerance is too small', () => {
    // The failure mode is not one spurious gap: each lane rebases every cycle,
    // ends up half empty, and the extent doubles. Worth a test so the cost of
    // choosing the tolerance too tightly is on the record.
    const tight = layOutEventTime(calls(repeat('ccccrrrr', 10)), 3);
    const correct = layOutEventTime(calls(repeat('ccccrrrr', 10)), 4);
    expect(correct.extentFrames).toBe(40);
    expect(tight.extentFrames).toBe(80);
    expect(tight.gaps.filter((g) => g.stream === 'capture').length).toBeGreaterThan(5);
    expect(tight.gaps.filter((g) => g.stream === 'render').length).toBeGreaterThan(5);
  });

  it('absorbs 40ms batching under the default policy', () => {
    expect(layOutEventTime(calls(repeat('ccccrrrr', 50))).gaps).toEqual([]);
    expect(layOutEventTime(calls(repeat('cccccccccc' + 'rrrrrrrrrr', 50))).gaps).toEqual([]);
  });
});

describe('jitter', () => {
  it('places crrccr densely in both lanes, with no collision or hole', () => {
    const layout = layOutEventTime(calls('crrccr'));
    expect(slots(layout, 'capture')).toEqual([0, 1, 2]);
    expect(slots(layout, 'render')).toEqual([0, 1, 2]);
    expect(layout.gaps).toEqual([]);
  });

  it('survives irregular but healthy serialization without gapping', () => {
    // Balanced 6-and-6, delivered in runs of one to three.
    const layout = layOutEventTime(calls(repeat('crrccrrcccrr', 40)));
    expect(layout.gaps).toEqual([]);
    expect(layout.captureRuns).toHaveLength(1);
    expect(layout.renderRuns).toHaveLength(1);
  });
});

describe('unequal recurring clustering', () => {
  it('absorbs healthy 40ms capture against 30ms render', () => {
    // The real case. Different callback sizes do not mean different amounts of
    // audio: over their common cycle a 40ms capture callback and a 30ms render
    // callback hand APM the same number of 10ms calls, just in different
    // batches. Nothing is missing, so nothing should gap.
    const sequence = scheduled(40, 30, 24_000);
    const layout = layOutEventTime(calls(sequence), DEFAULT_ALLOWED_LATENESS_FRAMES);
    expect(frameCount(layout.captureRuns)).toBe(frameCount(layout.renderRuns));
    expect(layout.gaps).toEqual([]);
    expect(layout.captureRuns).toHaveLength(1);
    expect(layout.renderRuns).toHaveLength(1);
  });

  it('absorbs a wider callback mismatch than the ratio alone suggests', () => {
    // 100ms against 30ms: the batches differ by 7 frames but the long-run
    // counts still match, so the tolerance absorbs it.
    const layout = layOutEventTime(calls(scheduled(100, 30, 30_000)));
    expect(frameCount(layout.captureRuns)).toBe(frameCount(layout.renderRuns));
    expect(layout.gaps).toEqual([]);
  });

  it('gaps the lane that genuinely delivers less audio', () => {
    // Not a callback mismatch: 4 capture calls against 3 render calls forever
    // is a persistent 25% render deficit, so render really is short and the
    // gaps are the audio it never sent.
    const layout = layOutEventTime(calls(repeat('ccccrrr', 100)), 10);
    expect(frameCount(layout.captureRuns)).toBe(400);
    expect(frameCount(layout.renderRuns)).toBe(300);
    expect(layout.gaps.every((g) => g.stream === 'render')).toBe(true);
    expect(layout.gaps.length).toBeGreaterThan(0);
    // Every slot the render lane spans is either audio or an acknowledged gap.
    // Its span ends where its audio ends, short of the capture lane's 400: the
    // file simply stopped, and asserting a gap past the last block would claim
    // something about a region with no evidence in it.
    const gapped = layout.gaps.reduce((t, g) => t + (g.eventEndFrame - g.eventStartFrame), 0);
    const runs = layout.renderRuns;
    const laneEnd = runs[runs.length - 1].eventStartFrame + runs[runs.length - 1].frameCount;
    expect(gapped + 300).toBe(laneEnd);
    expect(laneEnd).toBeLessThan(layout.extentFrames);
  });
});

describe('delayed start', () => {
  it('leaves a leading gap when render arrives far after capture', () => {
    const layout = layOutEventTime(calls(repeat('c', 300) + repeat('rc', 50)));
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0]).toMatchObject({
      stream: 'render',
      eventStartFrame: 0,
      eventEndFrame: 300,
      nextNativeFrame: 0,
      observedLagFrames: 300,
    });
    expect(layout.renderRuns[0].eventStartFrame).toBe(300);
  });

  it('is symmetric: a late capture start gaps the capture lane', () => {
    // 'cr' rather than 'rc' after the run, so the lagging lane's first call is
    // the first event of the pair and the frontier is at 300, mirroring above.
    const layout = layOutEventTime(calls(repeat('r', 300) + repeat('cr', 50)));
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0]).toMatchObject({
      stream: 'capture',
      eventStartFrame: 0,
      eventEndFrame: 300,
      nextNativeFrame: 0,
      observedLagFrames: 300,
    });
    expect(layout.captureRuns[0].eventStartFrame).toBe(300);
  });
});

describe('one-sided interruption', () => {
  it('leaves an internal gap where render stopped and resumed', () => {
    const layout = layOutEventTime(calls(repeat('rc', 50) + repeat('c', 200) + repeat('rc', 50)));
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0]).toMatchObject({
      stream: 'render',
      eventStartFrame: 50,
      eventEndFrame: 250,
      nextNativeFrame: 50,
    });
    // Stored audio stays contiguous either side: the gap is display space.
    expect(frameCount(layout.renderRuns)).toBe(100);
    expect(layout.renderRuns).toHaveLength(2);
  });

  it('leaves an internal gap where capture stopped and resumed', () => {
    const layout = layOutEventTime(calls(repeat('cr', 50) + repeat('r', 200) + repeat('cr', 50)));
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0]).toMatchObject({
      stream: 'capture',
      eventStartFrame: 50,
      eventEndFrame: 250,
      nextNativeFrame: 50,
    });
    expect(frameCount(layout.captureRuns)).toBe(100);
    expect(layout.captureRuns).toHaveLength(2);
  });

  it('extends the workspace for a render tail after capture ends', () => {
    const layout = layOutEventTime(calls(repeat('rc', 50) + repeat('r', 100)));
    expect(layout.extentFrames).toBe(150);
    expect(frameCount(layout.renderRuns)).toBe(150);
    expect(layout.gaps).toEqual([]);
  });

  it('extends the workspace for a capture tail after render ends', () => {
    const layout = layOutEventTime(calls(repeat('cr', 50) + repeat('c', 100)));
    expect(layout.extentFrames).toBe(150);
    expect(frameCount(layout.captureRuns)).toBe(150);
    expect(layout.gaps).toEqual([]);
  });
});

describe('single-stream dumps', () => {
  it('keeps a capture-only dump dense from the origin', () => {
    const layout = layOutEventTime(calls(repeat('c', 200)));
    expect(layout.captureRuns).toEqual([
      { nativeStartFrame: 0, eventStartFrame: 0, frameCount: 200 },
    ]);
    expect(layout.renderRuns).toEqual([]);
    expect(layout.gaps).toEqual([]);
  });

  it('keeps a render-only dump dense from the origin', () => {
    const layout = layOutEventTime(calls(repeat('r', 200)));
    expect(layout.renderRuns).toHaveLength(1);
    expect(layout.captureRuns).toEqual([]);
    expect(layout.gaps).toEqual([]);
  });

  it('handles an empty sequence', () => {
    const layout = layOutEventTime(calls(''));
    expect(layout).toMatchObject({ extentFrames: 0, captureRuns: [], renderRuns: [], gaps: [] });
  });
});

describe('policy', () => {
  it('records the policy it was built under', () => {
    expect(layOutEventTime(calls('rc')).allowedLatenessFrames).toBe(
      DEFAULT_ALLOWED_LATENESS_FRAMES
    );
    expect(layOutEventTime(calls('rc'), 4).allowedLatenessFrames).toBe(4);
  });

  it('never rebases at infinite tolerance', () => {
    const layout = layOutEventTime(calls(repeat('c', 500) + repeat('r', 500)), Infinity);
    expect(layout.gaps).toEqual([]);
    expect(layout.captureRuns[0].eventStartFrame).toBe(0);
    expect(layout.renderRuns[0].eventStartFrame).toBe(0);
    expect(layout.extentFrames).toBe(500);
  });

  it('rebases on every lag at zero tolerance', () => {
    const layout = layOutEventTime(calls('ccr'), 0);
    expect(layout.gaps).toHaveLength(1);
    expect(slots(layout, 'render')).toEqual([2]);
  });

  it('rejects a negative or NaN tolerance rather than laying out silently', () => {
    expect(() => layOutEventTime(calls('rc'), -1)).toThrow(/allowed lateness/);
    expect(() => layOutEventTime(calls('rc'), NaN)).toThrow(/allowed lateness/);
  });

  it('changes placement without changing how much audio is placed', () => {
    const sequence = calls(repeat('ccccrrr', 50));
    const tight = layOutEventTime(sequence, 2);
    const loose = layOutEventTime(sequence, 50);
    expect(frameCount(tight.renderRuns)).toBe(frameCount(loose.renderRuns));
    expect(frameCount(tight.captureRuns)).toBe(frameCount(loose.captureRuns));
    expect(tight.gaps.length).not.toBe(loose.gaps.length);
  });
});

describe('structural invariants', () => {
  const sequences = [
    repeat('rc', 100),
    repeat('ccccrrrr', 30),
    repeat('ccccrrr', 30),
    repeat('crrcccrcrrc', 20),
    repeat('c', 300) + repeat('rc', 50),
    repeat('rc', 50) + repeat('c', 200) + repeat('rc', 50),
    repeat('r', 50),
  ];
  const tolerances = [0, 1, 3, 4, 10, 100];

  it('places every native frame in exactly one run, in order', () => {
    for (const sequence of sequences) {
      for (const tolerance of tolerances) {
        const layout = layOutEventTime(calls(sequence), tolerance);
        for (const stream of ['capture', 'render'] as const) {
          const runs = runsFor(layout, stream);
          let expectedNative = 0;
          for (const run of runs) {
            expect(run.nativeStartFrame).toBe(expectedNative);
            expect(run.frameCount).toBeGreaterThan(0);
            expectedNative += run.frameCount;
          }
          const expected = sequence.split('').filter(
            (c) => c === (stream === 'capture' ? 'c' : 'r')
          ).length;
          expect(expectedNative).toBe(expected);
        }
      }
    }
  });

  it('keeps runs ordered, non-overlapping and slope one on the event axis', () => {
    for (const sequence of sequences) {
      for (const tolerance of tolerances) {
        const layout = layOutEventTime(calls(sequence), tolerance);
        for (const stream of ['capture', 'render'] as const) {
          const runs = runsFor(layout, stream);
          for (let i = 1; i < runs.length; i++) {
            const previousEnd = runs[i - 1].eventStartFrame + runs[i - 1].frameCount;
            expect(runs[i].eventStartFrame).toBeGreaterThanOrEqual(previousEnd);
          }
        }
      }
    }
  });

  it('never places a block inside a gap of its own lane', () => {
    for (const sequence of sequences) {
      for (const tolerance of tolerances) {
        const layout = layOutEventTime(calls(sequence), tolerance);
        for (const gap of layout.gaps) {
          for (const slot of slots(layout, gap.stream)) {
            expect(slot < gap.eventStartFrame || slot >= gap.eventEndFrame).toBe(true);
          }
        }
      }
    }
  });

  it('bounds the extent by the number of events, whatever the policy', () => {
    for (const sequence of sequences) {
      for (const tolerance of tolerances) {
        const layout = layOutEventTime(calls(sequence), tolerance);
        expect(layout.extentFrames).toBeLessThanOrEqual(sequence.length);
      }
    }
  });
});

describe('cursor mapping', () => {
  const layout = layOutEventTime(
    calls(repeat('rc', 50) + repeat('c', 200) + repeat('rc', 50)),
    10
  );

  it('maps a native frame to its event slot', () => {
    expect(toEventFrame(layout, 'render', 0)).toBe(0);
    expect(toEventFrame(layout, 'render', 49)).toBe(49);
    expect(toEventFrame(layout, 'capture', 249)).toBe(249);
  });

  it('jumps the cursor over a gap rather than waiting through it', () => {
    // Render frames 49 and 50 are adjacent in the audio but 200 slots apart on
    // screen, because nothing was delivered in between.
    expect(toEventFrame(layout, 'render', 49)).toBe(49);
    expect(toEventFrame(layout, 'render', 50)).toBe(250);
  });

  it('returns null for a frame the layout never placed', () => {
    // 100 is the exclusive end and does map -- see the finished-cursor case.
    expect(toEventFrame(layout, 'render', 101)).toBeNull();
    expect(toEventFrame(layout, 'render', -1)).toBeNull();
  });

  it('inverts exactly inside a run', () => {
    expect(toNativeFrame(layout, 'render', 30)).toEqual({ nativeFrame: 30, resolution: 'exact' });
    expect(toNativeFrame(layout, 'render', 250)).toEqual({
      nativeFrame: 50,
      resolution: 'exact',
    });
  });

  it('snaps forward from inside a gap and says so', () => {
    expect(toNativeFrame(layout, 'render', 120)).toEqual({
      nativeFrame: 50,
      resolution: 'snapped-forward',
    });
  });

  it('clamps past the final run to the end of the audio', () => {
    // The end position, not the start of the final block: clicking past the
    // tail should land where playback finishes, one frame later than frame 99.
    expect(toNativeFrame(layout, 'render', 100_000)).toEqual({
      nativeFrame: 100,
      resolution: 'clamped-to-end',
    });
  });

  it('snaps forward from before a leading gap', () => {
    const late = layOutEventTime(calls(repeat('c', 300) + repeat('rc', 50)));
    expect(toNativeFrame(late, 'render', 0)).toEqual({
      nativeFrame: 0,
      resolution: 'snapped-forward',
    });
  });

  it('reports an empty lane rather than inventing a position', () => {
    const captureOnly = layOutEventTime(calls(repeat('c', 10)));
    expect(toNativeFrame(captureOnly, 'render', 5)).toEqual({
      nativeFrame: 0,
      resolution: 'empty',
    });
  });

  it('round-trips every placed frame', () => {
    for (const stream of ['capture', 'render'] as const) {
      for (const run of runsFor(layout, stream)) {
        for (let i = 0; i < run.frameCount; i++) {
          const native = run.nativeStartFrame + i;
          const event = toEventFrame(layout, stream, native)!;
          expect(toNativeFrame(layout, stream, event)).toEqual({
            nativeFrame: native,
            resolution: 'exact',
          });
        }
      }
    }
  });

  it('keeps the fractional part inside a run, to the sample', () => {
    // Slope one, so the fraction passes through. Flooring here would seek up to
    // 9ms early for a click part-way through a drawn block.
    expect(toNativeFrame(layout, 'capture', 30.9)).toEqual({
      nativeFrame: 30.9,
      resolution: 'exact',
    });
    expect(toNativeFrame(layout, 'render', 250.5)).toEqual({
      nativeFrame: 50.5,
      resolution: 'exact',
    });
  });

  it('drops the fraction when snapping, because a snap lands on a boundary', () => {
    expect(toNativeFrame(layout, 'render', 120.7)).toEqual({
      nativeFrame: 50,
      resolution: 'snapped-forward',
    });
  });

  it('round-trips fractional positions', () => {
    for (const event of [0.25, 30.9, 49.999, 250.5, 299.75]) {
      const { nativeFrame, resolution } = toNativeFrame(layout, 'render', event);
      if (resolution !== 'exact') continue;
      expect(toEventFrame(layout, 'render', nativeFrame)).toBeCloseTo(event, 9);
    }
  });

  it('places the position a finished cursor reaches, at the exact end', () => {
    // The half-open runs contain no position at the very end, but that is where
    // a playing cursor stops, and it must still draw somewhere.
    expect(toEventFrame(layout, 'render', 100)).toBe(300);
    expect(toEventFrame(layout, 'capture', 300)).toBe(300);
    expect(toEventFrame(layout, 'render', 100.0001)).toBeNull();
  });

  it('refuses a non-finite position rather than returning NaN as exact', () => {
    expect(toEventFrame(layout, 'render', NaN)).toBeNull();
    expect(toEventFrame(layout, 'render', Infinity)).toBeNull();
    expect(() => toNativeFrame(layout, 'render', NaN)).toThrow(/cannot seek/);
    expect(() => toNativeFrame(layout, 'render', -Infinity)).toThrow(/cannot seek/);
  });
});

describe('continuity across INIT', () => {
  it('does not reset event time at a segment boundary', () => {
    // An INIT cuts the streams into separately formatted tracks but resets
    // neither clock. Laying each segment out from zero would silently realign
    // every reconfiguration.
    const split = layOutEventTime([
      { startFrame: 0, calls: Uint8Array.from(repeat('rc', 50), (c) => c.charCodeAt(0)) },
      { startFrame: 50, calls: Uint8Array.from(repeat('rc', 50), (c) => c.charCodeAt(0)) },
    ]);
    expect(split).toEqual(layOutEventTime(calls(repeat('rc', 100))));
    expect(split.captureRuns).toHaveLength(1);
    expect(split.extentFrames).toBe(100);
  });

  it('carries a lagging lane across the boundary and rebases on the far side', () => {
    // Render falls behind during segment one and only crosses the tolerance
    // after the INIT. The rebase must still happen.
    const layout = layOutEventTime(
      [
        { startFrame: 0, calls: Uint8Array.from('r' + repeat('c', 8), (c) => c.charCodeAt(0)) },
        { startFrame: 8, calls: Uint8Array.from(repeat('c', 8) + 'r', (c) => c.charCodeAt(0)) },
      ],
      10
    );
    expect(layout.gaps).toEqual([
      {
        stream: 'render',
        eventStartFrame: 1,
        eventEndFrame: 16,
        nextNativeFrame: 1,
        observedLagFrames: 15,
      },
    ]);
    expect(frameCount(layout.captureRuns)).toBe(16);
  });

  it('ignores segments that carried no calls', () => {
    const layout = layOutEventTime([
      { startFrame: 0, calls: Uint8Array.from(repeat('rc', 10), (c) => c.charCodeAt(0)) },
      { startFrame: 10, calls: new Uint8Array(0) },
      { startFrame: 10, calls: Uint8Array.from(repeat('rc', 10), (c) => c.charCodeAt(0)) },
    ]);
    expect(layout.captureRuns).toHaveLength(1);
    expect(layout.extentFrames).toBe(20);
  });
});

describe('repeated rebases', () => {
  const layout = layOutEventTime(calls(repeat('ccccrrr', 200)), 4);

  it('reports the native frame that resumes after each gap', () => {
    expect(layout.gaps.length).toBeGreaterThan(10);
    for (const gap of layout.gaps) {
      expect(gap.stream).toBe('render');
      // Everything placed before the gap is exactly what precedes the resume.
      expect(gap.nextNativeFrame).toBe(framesBefore(layout, gap.eventStartFrame));
    }
  });

  it('keeps gaps ordered and non-overlapping within a lane', () => {
    for (const stream of ['capture', 'render'] as const) {
      const laneGaps = layout.gaps.filter((g) => g.stream === stream);
      for (let i = 1; i < laneGaps.length; i++) {
        expect(laneGaps[i].eventStartFrame).toBeGreaterThanOrEqual(laneGaps[i - 1].eventEndFrame);
      }
      for (const gap of laneGaps) {
        expect(gap.eventEndFrame).toBeGreaterThan(gap.eventStartFrame);
      }
    }
  });

  it('lays out a heavily rebasing dump in linear time', () => {
    // Every event rebases at zero tolerance, so this is the worst case for any
    // per-rebase walk over the runs already built.
    const heavy = calls(repeat('cr', 20_000));
    const started = performance.now();
    const result = layOutEventTime(heavy, 0);
    expect(result.gaps.length).toBeGreaterThan(30_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

/** Render frames placed before an event slot, for the gap bookkeeping check. */
function framesBefore(layout: EventTimeLayout, eventFrame: number): number {
  return layout.renderRuns
    .filter((r) => r.eventStartFrame < eventFrame)
    .reduce((t, r) => t + r.frameCount, 0);
}
