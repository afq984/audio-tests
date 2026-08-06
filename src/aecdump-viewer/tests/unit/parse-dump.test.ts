import { describe, it, expect } from 'vitest';
import { parseDump } from '../../src/parse-dump.js';
import { allTracks, dumpDuration, framesToSeconds } from '../../src/dump-model.js';
import {
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
