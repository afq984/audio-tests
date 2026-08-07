import { describe, it, expect } from 'vitest';
import { parseDump } from '../../src/parse-dump.js';
import { CALL_RENDER, allTracks, dumpDuration, framesToSeconds } from '../../src/dump-model.js';
import {
  makeCallOrderDump,
  makeReversePayloadDump,
  makeSegmentedDump,
  makeFloatDump,
  makeInt16Dump,
  samplesPerFrame,
} from '../fixtures/make-dump.js';

const RATE = 16000;
const PER_FRAME = samplesPerFrame(RATE);

describe('segments', () => {
  it('produces one segment per INIT', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: 16000, channels: 1 },
        { frames: 6, sampleRate: 48000, channels: 2 },
      ])
    );
    expect(dump.segments).toHaveLength(2);
    expect(dump.captureFrameCount).toBe(16);
    expect(dump.warnings).toEqual([]);
  });

  it('starts each segment at the cumulative capture frame count', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: RATE },
        { frames: 6, sampleRate: RATE },
        { frames: 4, sampleRate: RATE },
      ])
    );
    expect(dump.segments.map((s) => s.startFrame)).toEqual([0, 10, 16]);
    expect(dump.segments.map((s) => s.frameCount)).toEqual([10, 6, 4]);
    expect(dump.segments.map((s) => s.initIndex)).toEqual([1, 2, 3]);
  });

  it('names tracks the way unpack_aecdump does', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: RATE },
        { frames: 6, sampleRate: RATE },
      ])
    );
    expect(allTracks(dump).map((t) => t.name)).toEqual([
      'reverse0.wav',
      'input0.wav',
      'ref_out0.wav',
      'reverse10.wav',
      'input10.wav',
      'ref_out10.wav',
    ]);
  });

  it('keeps each segment at its own format', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: 16000, channels: 1 },
        { frames: 6, sampleRate: 48000, channels: 2 },
      ])
    );
    const [first, second] = dump.segments;
    expect(first.formats.input).toEqual({ sampleRate: 16000, channels: 1 });
    expect(second.formats.input).toEqual({ sampleRate: 48000, channels: 2 });

    const firstInput = first.tracks.find((t) => t.kind === 'input')!;
    const secondInput = second.tracks.find((t) => t.kind === 'input')!;
    expect(firstInput.channelData).toHaveLength(1);
    expect(secondInput.channelData).toHaveLength(2);
    // A rate change no longer corrupts the timeline: each segment's samples
    // are laid down at the rate its own INIT declared.
    expect(firstInput.channelData[0].length).toBe(10 * (16000 / 100));
    expect(secondInput.channelData[0].length).toBe(6 * (48000 / 100));
  });

  it('positions each segment on the capture timeline', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 100, sampleRate: RATE },
        { frames: 50, sampleRate: RATE },
      ])
    );
    const [first, second] = dump.segments;
    expect(first.tracks[0].startTime).toBeCloseTo(0, 9);
    // 100 frames x 10ms
    expect(second.tracks[0].startTime).toBeCloseTo(1.0, 9);
    expect(second.tracks.find((t) => t.kind === 'input')!.duration).toBeCloseTo(0.5, 9);
    expect(dumpDuration(dump)).toBeCloseTo(1.5, 9);
  });

  it('carries the INIT timestamp when the dump has one', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 4, sampleRate: RATE, timestampMs: 1700000000000 },
        { frames: 4, sampleRate: RATE },
      ])
    );
    expect(dump.segments[0].timestampMs).toBe(1700000000000);
    expect(dump.segments[1].timestampMs).toBeUndefined();
  });

  it('handles int16 dumps in segments too', () => {
    const dump = parseDump(
      makeSegmentedDump([{ frames: 8, sampleRate: RATE }, { frames: 4, sampleRate: RATE }], {
        float: false,
      })
    );
    expect(dump.segments).toHaveLength(2);
    const input = dump.segments[1].tracks.find((t) => t.kind === 'input')!;
    expect(input.channelData[0].length).toBe(4 * PER_FRAME);
  });
});

describe('single-segment dumps', () => {
  it('reports one segment starting at frame zero', () => {
    const dump = parseDump(makeFloatDump({ frames: 20, sampleRate: RATE }));
    expect(dump.segments).toHaveLength(1);
    expect(dump.segments[0].startFrame).toBe(0);
    expect(dump.segments[0].frameCount).toBe(20);
  });

  it('omits a stream that never carried data', () => {
    const dump = parseDump(
      makeFloatDump({
        frames: 10,
        sampleRate: RATE,
        dropOutput: [...Array(10).keys()],
      })
    );
    const kinds = dump.segments[0].tracks.map((t) => t.kind);
    expect(kinds).toContain('input');
    expect(kinds).not.toContain('ref_out');
  });

  it('keeps input and output in lockstep within a segment', () => {
    const dump = parseDump(
      makeFloatDump({ frames: 20, sampleRate: RATE, dropOutput: [5, 6, 7, 18, 19] })
    );
    const segment = dump.segments[0];
    const input = segment.tracks.find((t) => t.kind === 'input')!;
    const output = segment.tracks.find((t) => t.kind === 'ref_out')!;
    expect(output.channelData[0].length).toBe(input.channelData[0].length);
    expect(output.channelData[0].length).toBe(20 * PER_FRAME);
  });
});

describe('malformed input', () => {
  it('records a warning instead of throwing on truncation', () => {
    const full = makeInt16Dump({ frames: 10, sampleRate: RATE });
    const dump = parseDump(full.slice(0, Math.floor(full.byteLength * 0.6)));
    expect(dump.warnings.length).toBeGreaterThan(0);
    expect(dump.segments).toHaveLength(1);
    expect(dump.captureFrameCount).toBeGreaterThan(0);
  });

  it('returns nothing for an empty buffer', () => {
    const dump = parseDump(new ArrayBuffer(0));
    expect(dump.segments).toEqual([]);
    expect(dump.captureFrameCount).toBe(0);
    expect(dumpDuration(dump)).toBe(0);
  });
});

describe('framesToSeconds', () => {
  it('treats a frame as 10ms', () => {
    expect(framesToSeconds(100)).toBeCloseTo(1.0, 9);
    expect(framesToSeconds(1)).toBeCloseTo(0.01, 9);
  });
});

describe('call order as ordinal evidence', () => {
  it('records an irregular interleaving without touching the audio', () => {
    // The reverse stream runs on its own hardware clock, so an order like
    // crrccr is ordinary jitter rather than a fault.
    const dump = parseDump(makeCallOrderDump('crrccr'));
    const segment = dump.segments[0];

    // The raw sequence is kept verbatim. Nothing derived from it is stored:
    // a per-render-frame capture position would read as a coordinate, and
    // call order records when events were serialized, not when a clock ticked.
    expect(String.fromCharCode(...dump.callOrder[0].calls)).toBe('crrccr');

    // Three render calls means three frames of samples: no silence is injected
    // to drag the render stream onto the capture clock, and none is dropped
    // where two render calls share a capture interval.
    const reverse = segment.tracks.find((t) => t.kind === 'reverse')!;
    expect(reverse.channelData[0].length).toBe(3 * PER_FRAME);
    expect(reverse.timeline).toBe('render');

    // The track keeps its native start. Placing it against capture is a
    // display-time decision, made by the event-time layout.
    expect(reverse.startTime).toBe(0);
  });

  it('labels capture-aligned tracks as such', () => {
    const dump = parseDump(makeCallOrderDump('rcrc'));
    const kinds = Object.fromEntries(
      dump.segments[0].tracks.map((t) => [t.kind, t.timeline])
    );
    expect(kinds).toEqual({ reverse: 'render', input: 'capture', ref_out: 'capture' });
  });

  it('keeps leading render calls in the sequence', () => {
    const dump = parseDump(makeCallOrderDump('rrcc'));
    expect(String.fromCharCode(...dump.callOrder[0].calls)).toBe('rrcc');
  });

  it('records an empty render side rather than omitting it', () => {
    const dump = parseDump(makeCallOrderDump('cccc'));
    expect(String.fromCharCode(...dump.callOrder[0].calls)).toBe('cccc');
  });

  it('counts capture frames from the segment start, not the dump start', () => {
    const dump = parseDump(makeCallOrderDump('cccc'));
    expect(dump.segments[0].startFrame).toBe(0);
    expect(dump.captureFrameCount).toBe(4);
  });
});

describe('native track origins', () => {
  it('keeps render and capture origins separate across segments', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 100, sampleRate: RATE, reverseOnlyFrames: 100 },
        { frames: 50, sampleRate: RATE },
      ])
    );
    const [first, second] = dump.segments;
    // Segment one carries 200 render calls (100 extra plus one per capture)
    // against 100 capture frames.
    expect(first.startRenderFrame).toBe(0);
    expect(second.startFrame).toBe(100);
    expect(second.startRenderFrame).toBe(200);

    const reverse = second.tracks.find((t) => t.kind === 'reverse')!;
    const input = second.tracks.find((t) => t.kind === 'input')!;
    expect(reverse.startTime).toBeCloseTo(2.0, 9);
    expect(input.startTime).toBeCloseTo(1.0, 9);
  });

  it('leaves both origins equal when the clocks stay locked', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 100, sampleRate: RATE },
        { frames: 50, sampleRate: RATE },
      ])
    );
    const second = dump.segments[1];
    expect(second.startRenderFrame).toBe(second.startFrame);
    expect(second.tracks.find((t) => t.kind === 'reverse')!.startTime).toBeCloseTo(1.0, 9);
  });
});

describe('reverse events with no payload', () => {
  it('skips them, keeping call count and sample count in step', () => {
    // No stock WebRTC build emits these, so the parser defines the semantics:
    // an event carrying no audio is not a render frame.
    const dump = parseDump(
      makeSegmentedDump([{ frames: 10, sampleRate: RATE, emptyReverse: [3, 7] }])
    );
    const segment = dump.segments[0];
    const reverse = segment.tracks.find((t) => t.kind === 'reverse')!;
    const renderCalls = dump.callOrder[0].calls.filter((c) => c === CALL_RENDER).length;

    expect(renderCalls).toBe(8);
    expect(reverse.channelData[0].length).toBe(8 * PER_FRAME);
    // The invariant the event-time runs depend on: one call, one block.
    expect(reverse.channelData[0].length / PER_FRAME).toBe(renderCalls);
  });

  it('compacts the stream, preserving sample order and block boundaries', () => {
    // Not "nothing moves": the skipped event's frame is gone, so later audio
    // sits one native position earlier. What must hold is that every remaining
    // block keeps its order and stays on a frame boundary, so one call still
    // means one block.
    const clean = parseDump(makeSegmentedDump([{ frames: 10, sampleRate: RATE }]));
    const holed = parseDump(
      makeSegmentedDump([{ frames: 10, sampleRate: RATE, emptyReverse: [3] }])
    );
    const from = (dump: ReturnType<typeof parseDump>, frame: number) =>
      Array.from(
        dump.segments[0].tracks
          .find((t) => t.kind === 'reverse')!
          .channelData[0].subarray(frame * PER_FRAME, (frame + 1) * PER_FRAME)
      );

    // Frame 3 of the holed stream is the audio that was frame 4 of the clean
    // one: the skipped event contributed nothing and nothing was invented for
    // it. Every later frame follows in order, one position earlier.
    expect(from(holed, 3)).toEqual(from(clean, 4));
    expect(from(holed, 6)).toEqual(from(clean, 7));
    expect(from(holed, 0)).toEqual(from(clean, 0));
  });

  it('warns rather than shrinking the stream silently', () => {
    const dump = parseDump(
      makeSegmentedDump([{ frames: 10, sampleRate: RATE, emptyReverse: [3, 7] }])
    );
    expect(dump.warnings).toHaveLength(1);
    expect(dump.warnings[0]).toMatch(/2 reverse events carried no audio/);
    expect(dump.warnings[0]).toMatch(/call order/);
  });

  it('uses the singular for a single event', () => {
    const dump = parseDump(
      makeSegmentedDump([{ frames: 5, sampleRate: RATE, emptyReverse: [1] }])
    );
    expect(dump.warnings[0]).toMatch(/1 reverse event carried no audio and was skipped/);
  });

  it('says nothing when every reverse event carries audio', () => {
    const dump = parseDump(makeSegmentedDump([{ frames: 5, sampleRate: RATE }]));
    expect(dump.warnings).toEqual([]);
  });

  it('keeps the render origin of a later segment consistent with the audio', () => {
    // A skipped event must not advance the render clock either, or the next
    // segment's reverse track would start one frame late.
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: RATE, emptyReverse: [2] },
        { frames: 5, sampleRate: RATE },
      ])
    );
    expect(dump.segments[1].startRenderFrame).toBe(9);
    expect(dump.segments[0].tracks.find((t) => t.kind === 'reverse')!.channelData[0].length).toBe(
      9 * PER_FRAME
    );
  });
});

describe('reverse events that do not carry a whole frame', () => {
  const withReversePayload = makeReversePayloadDump;

  it('skips a present but empty float channel, which a length test would pass', () => {
    // `channel: [<empty>]` has length 1, so an outer-length check counts it as
    // a render frame while it decodes to no samples at all.
    const dump = parseDump(withReversePayload({ channel: [new Uint8Array(0)] }));
    expect(dump.callOrder[0].calls).toHaveLength(0);
    expect(dump.segments[0].tracks.find((t) => t.kind === 'reverse')).toBeUndefined();
    expect(dump.warnings.join(' ')).toMatch(/whole frame/);
  });

  it('skips an int16 payload too short to decode a sample', () => {
    const dump = parseDump(withReversePayload({ data: new Uint8Array([0]) }));
    expect(dump.callOrder[0].calls).toHaveLength(0);
    expect(dump.warnings.join(' ')).toMatch(/whole frame/);
  });

  it('skips a payload that is a partial frame', () => {
    // Half a frame would leave every later block off its sample boundary,
    // which is worse than a missing frame: nothing after it lands on the grid.
    const dump = parseDump(withReversePayload({ data: new Uint8Array(PER_FRAME) }));
    expect(dump.callOrder[0].calls).toHaveLength(0);
    expect(dump.warnings.join(' ')).toMatch(/whole frame/);
  });

  it('skips a payload longer than a frame', () => {
    const dump = parseDump(withReversePayload({ data: new Uint8Array(PER_FRAME * 4) }));
    expect(dump.callOrder[0].calls).toHaveLength(0);
  });

  it('accepts an exactly sized payload', () => {
    const dump = parseDump(withReversePayload({ data: new Uint8Array(PER_FRAME * 2) }));
    expect(dump.callOrder[0].calls).toHaveLength(1);
    expect(dump.warnings).toEqual([]);
    expect(
      dump.segments[0].tracks.find((t) => t.kind === 'reverse')!.channelData[0].length
    ).toBe(PER_FRAME);
  });

  it('distinguishes a missing payload from a malformed one', () => {
    const missing = parseDump(withReversePayload({}));
    expect(missing.warnings.join(' ')).toMatch(/carried no audio/);
    expect(missing.warnings.join(' ')).not.toMatch(/whole frame/);
  });
});

describe('call order origins', () => {
  it('carries both native origins, so the layout can number its lanes', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: RATE, reverseOnlyFrames: 5 },
        { frames: 6, sampleRate: RATE },
      ])
    );
    expect(dump.callOrder.map((c) => c.startFrame)).toEqual([0, 10]);
    expect(dump.callOrder.map((c) => c.startRenderFrame)).toEqual([0, 15]);
    // The origins match the segments they came from, which is what makes a
    // track's startFrame and a layout run's nativeStartFrame the same axis.
    expect(dump.callOrder.map((c) => c.startRenderFrame)).toEqual(
      dump.segments.map((s) => s.startRenderFrame)
    );
  });

  it('excludes skipped reverse events from the render origin', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: RATE, emptyReverse: [2, 5] },
        { frames: 6, sampleRate: RATE },
      ])
    );
    expect(dump.callOrder[1].startRenderFrame).toBe(8);
    expect(dump.segments[1].startRenderFrame).toBe(8);
  });
});
