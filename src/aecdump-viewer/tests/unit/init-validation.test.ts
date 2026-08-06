import { describe, it, expect } from 'vitest';
import { parseDump } from '../../src/parse-dump.js';
import { allTracks } from '../../src/dump-model.js';
import { makeRawDump, makeSegmentedDump } from '../fixtures/make-dump.js';

describe('INIT validation', () => {
  it('warns rather than silently guessing a missing capture rate', () => {
    const dump = parseDump(makeRawDump({ init: { numInputChannels: 1 }, frames: 4 }));
    expect(dump.warnings.join(' ')).toMatch(/implausible capture sample rate/);
    // It still decodes, so the audio is inspectable, but the guess is stated.
    expect(dump.segments).toHaveLength(1);
  });

  it('falls back to the capture rate for an absent reverse or output rate', () => {
    const dump = parseDump(
      makeRawDump({
        init: { sampleRate: 48000, numInputChannels: 1 },
        frames: 2,
      })
    );
    const [segment] = dump.segments;
    expect(segment.formats.reverse.sampleRate).toBe(48000);
    expect(segment.formats.ref_out.sampleRate).toBe(48000);
    expect(dump.warnings.filter((w) => /reverse|output/.test(w))).toEqual([]);
  });

  it('rejects a segment whose channel count would drive a huge allocation', () => {
    const dump = parseDump(
      makeRawDump({ init: { sampleRate: 16000, numInputChannels: 100000 }, frames: 4 })
    );
    expect(dump.warnings.join(' ')).toMatch(/cannot be right/);
    expect(dump.segments).toEqual([]);
    // The capture timeline still advances, so later segments stay positioned.
    expect(dump.captureFrameCount).toBe(4);
  });

  it('warns about an implausible reverse rate and uses the capture rate', () => {
    const dump = parseDump(
      makeRawDump({
        init: { sampleRate: 16000, reverseSampleRate: 999999999, numInputChannels: 1 },
        frames: 2,
      })
    );
    expect(dump.warnings.join(' ')).toMatch(/implausible reverse sample rate/);
    expect(dump.segments[0].formats.reverse.sampleRate).toBe(16000);
  });
});

describe('track identity', () => {
  it('gives every track a stable id even when names collide', () => {
    // A reverse-only segment advances no capture frames, so the next INIT
    // lands on the same frame and produces the same unpack-style filename.
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 0, reverseOnlyFrames: 3, sampleRate: 16000 },
        { frames: 4, sampleRate: 16000 },
      ])
    );
    const tracks = allTracks(dump);
    const names = tracks.map((t) => t.name);
    const ids = tracks.map((t) => t.id);

    // The names genuinely collide -- that is the point of having ids.
    expect(names.filter((n) => n === 'reverse0.wav')).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keys the id on the INIT index and kind', () => {
    const dump = parseDump(makeSegmentedDump([{ frames: 4, sampleRate: 16000 }]));
    expect(allTracks(dump).map((t) => t.id)).toEqual([
      'init1:reverse',
      'init1:input',
      'init1:ref_out',
    ]);
  });
});

describe('frame size', () => {
  it('truncates like unpack.cc rather than rounding', () => {
    // 22050 / 100 truncates to 220 in C++, not 221.
    const dump = parseDump(makeRawDump({ init: { sampleRate: 22050, numInputChannels: 1 }, frames: 3 }));
    const input = dump.segments[0].tracks.find((t) => t.kind === 'input')!;
    expect(input.channelData[0].length % 3).toBe(0);
    expect(input.channelData[0].length / 3).toBe(220);
  });
});
