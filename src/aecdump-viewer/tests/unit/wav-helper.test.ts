import { describe, it, expect } from 'vitest';
import { audioBufferToWav } from '../../src/wav-helper.js';

const RATE = 16000;
const FRAMES = 1600; // 100ms

/**
 * Minimal stand-in for AudioBuffer; audioBufferToWav only reads these three
 * members, and there is no Web Audio API under the unit test runner.
 */
function fakeBuffer(numChannels: number): AudioBuffer {
  const channels = Array.from({ length: numChannels }, (_, c) => {
    const data = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i++) {
      data[i] = (Math.sin(i / 10) * (c + 1)) / numChannels;
    }
    return data;
  });
  return {
    numberOfChannels: numChannels,
    sampleRate: RATE,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

function readWavHeader(wav: ArrayBuffer) {
  const view = new DataView(wav);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitDepth = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const frames = dataBytes / (channels * (bitDepth / 8));
  return { channels, sampleRate, bitDepth, frames, durationMs: (frames / sampleRate) * 1000 };
}

describe('audioBufferToWav', () => {
  it.each([1, 2, 3, 4, 8])(
    'preserves all %i channels and writes interleaved frames',
    (numChannels) => {
      const buf = fakeBuffer(numChannels);
      const wav = audioBufferToWav(buf);
      const header = readWavHeader(wav);
      expect(header.channels).toBe(numChannels);
      expect(header.durationMs).toBeCloseTo(100, 6);
      expect(header.sampleRate).toBe(RATE);
      expect(header.frames).toBe(FRAMES);

      // Verify sample interleaving in 16-bit PCM data at frame 5
      const view = new DataView(wav);
      const frameIdx = 5;
      for (let c = 0; c < numChannels; c++) {
        const expectedFloat = buf.getChannelData(c)[frameIdx];
        const clamped = Math.max(-1, Math.min(1, expectedFloat));
        const expectedInt16 = Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
        const byteOffset = 44 + (frameIdx * numChannels + c) * 2;
        expect(view.getInt16(byteOffset, true)).toBe(expectedInt16);
      }
    }
  );

  it('writes 16-bit PCM by default and 32-bit float on request', () => {
    expect(readWavHeader(audioBufferToWav(fakeBuffer(1))).bitDepth).toBe(16);
    const float = audioBufferToWav(fakeBuffer(3), { float32: true });
    const header = readWavHeader(float);
    expect(header.channels).toBe(3);
    expect(header.bitDepth).toBe(32);
    expect(header.durationMs).toBeCloseTo(100, 6);
  });
});

