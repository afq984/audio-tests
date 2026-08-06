import { describe, it, expect } from 'vitest';
import { parseDump } from '../../src/parse-dump.js';
import { CALL_CAPTURE, CALL_RENDER } from '../../src/dump-model.js';
import { makeMetadataDump, makeSegmentedDump } from '../fixtures/make-dump.js';

const decodeCalls = (calls: Uint8Array) => String.fromCharCode(...calls);

describe('metadata series', () => {
  it('indexes values by capture frame', () => {
    const dump = parseDump(makeMetadataDump({ frames: 10, delayAt: (i) => 40 + i }));
    expect(dump.series.delay).not.toBeNull();
    expect(dump.series.delay!.length).toBe(10);
    expect(Array.from(dump.series.delay!)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
    expect(Array.from(dump.series.delayPresent!)).toEqual(Array(10).fill(1));
  });

  it('is null for a field no event carried', () => {
    const dump = parseDump(makeMetadataDump({ frames: 5 }));
    // The fixture writes delay by default but nothing else.
    expect(dump.series.delay).not.toBeNull();
    expect(dump.series.drift).toBeNull();
    expect(dump.series.appliedInputVolume).toBeNull();
    expect(dump.series.keypress).toBeNull();
  });

  it('distinguishes an absent frame from a genuine zero', () => {
    // Frame 2 reports 0; frames 1 and 3 report nothing at all.
    const dump = parseDump(
      makeMetadataDump({
        frames: 5,
        delayAt: (i) => (i === 1 || i === 3 ? undefined : i === 2 ? 0 : 50),
      })
    );
    expect(Array.from(dump.series.delay!)).toEqual([50, 0, 0, 0, 50]);
    expect(Array.from(dump.series.delayPresent!)).toEqual([1, 0, 1, 0, 1]);
  });

  it('collects drift, applied volume and keypress', () => {
    const dump = parseDump(
      makeMetadataDump({
        frames: 4,
        driftAt: (i) => -i,
        volumeAt: () => 128,
        keypressAt: (i) => i === 2,
      })
    );
    expect(Array.from(dump.series.drift!)).toEqual([0, -1, -2, -3]);
    expect(Array.from(dump.series.appliedInputVolume!)).toEqual([128, 128, 128, 128]);
    expect(Array.from(dump.series.keypress!)).toEqual([0, 0, 1, 0]);
  });
});

describe('markers', () => {
  it('records an INIT marker per segment with its formats', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 10, sampleRate: 16000, channels: 1 },
        { frames: 5, sampleRate: 48000, channels: 2 },
      ])
    );
    const inits = dump.markers.filter((m) => m.kind === 'init');
    expect(inits.map((m) => [m.label, m.frame])).toEqual([
      ['Init #1', 0],
      ['Init #2', 10],
    ]);
    expect(inits[1].time).toBeCloseTo(0.1, 9);
    expect(inits[1].detail).toContainEqual(['input', '48000Hz x2']);
  });

  it('records CONFIG changes at the capture frame they occur', () => {
    const dump = parseDump(
      makeMetadataDump({
        frames: 10,
        configAt: { 4: { aecEnabled: true, nsLevel: 2, apiConfigString: 'AEC3' } },
      })
    );
    const config = dump.markers.find((m) => m.kind === 'config')!;
    expect(config.frame).toBe(4);
    expect(config.time).toBeCloseTo(0.04, 9);
    expect(config.detail).toEqual([
      ['aecEnabled', 'true'],
      ['nsLevel', '2'],
      ['apiConfigString', 'AEC3'],
    ]);
  });

  it('omits config fields the event did not set', () => {
    const dump = parseDump(makeMetadataDump({ frames: 4, configAt: { 1: { nsEnabled: false } } }));
    const config = dump.markers.find((m) => m.kind === 'config')!;
    // A proto2 bool that is absent must not appear as false.
    expect(config.detail).toEqual([['nsEnabled', 'false']]);
  });

  it('records runtime settings', () => {
    const dump = parseDump(
      makeMetadataDump({ frames: 6, runtimeSettingAt: { 3: { capturePreGain: 2.5 } } })
    );
    const setting = dump.markers.find((m) => m.kind === 'runtime-setting')!;
    expect(setting.frame).toBe(3);
    expect(setting.label).toBe('capturePreGain');
    expect(setting.detail).toEqual([['capturePreGain', '2.5']]);
  });
});

describe('call order', () => {
  it('records one entry per event in file order', () => {
    const dump = parseDump(makeMetadataDump({ frames: 3 }));
    expect(dump.callOrder).toHaveLength(1);
    // The fixture emits one render call before each capture call.
    expect(decodeCalls(dump.callOrder[0].calls)).toBe('rcrcrc');
    expect(dump.callOrder[0].startFrame).toBe(0);
  });

  it('splits per segment, like callorder<suffix>.char', () => {
    const dump = parseDump(
      makeSegmentedDump([
        { frames: 3, sampleRate: 16000 },
        { frames: 2, sampleRate: 16000 },
      ])
    );
    expect(dump.callOrder.map((c) => c.startFrame)).toEqual([0, 3]);
    expect(dump.callOrder.map((c) => decodeCalls(c.calls))).toEqual(['rcrcrc', 'rcrc']);
  });

  it('uses the same characters as upstream', () => {
    const dump = parseDump(makeMetadataDump({ frames: 1 }));
    expect(Array.from(dump.callOrder[0].calls)).toEqual([CALL_RENDER, CALL_CAPTURE]);
    expect(String.fromCharCode(CALL_RENDER, CALL_CAPTURE)).toBe('rc');
  });

  it('reflects a render stream that stops', () => {
    const dump = parseDump(
      makeSegmentedDump([{ frames: 3, sampleRate: 16000, reverse: false }])
    );
    expect(decodeCalls(dump.callOrder[0].calls)).toBe('ccc');
  });
});
