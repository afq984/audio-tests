/**
 * Synthesizes aecdump files for tests.
 *
 * The dump format is a sequence of [int32 little-endian length][Event protobuf]
 * records, matching what WebRTC's AecDump writer produces and what
 * rtc_tools/unpack_aecdump reads. One STREAM event is one 10ms capture frame.
 */
import { webrtc } from '../../src/proto/debug.js';

const Event = webrtc.audioproc.Event;

/** Samples per channel in one 10ms APM frame, as unpack.cc computes it. */
export function samplesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate / 100);
}

function frameMessage(payload: webrtc.audioproc.IEvent): Uint8Array {
  const body = Event.encode(payload).finish();
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setInt32(0, body.length, true);
  out.set(body, 4);
  return out;
}

function concat(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

/** Interleaved int16 payload: `samples` per channel across `channels`. */
function int16Payload(samples: number, channels: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(samples * channels * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples * channels; i++) {
    view.setInt16(i * 2, ((seed + i) % 1000) * 30, true);
  }
  return bytes;
}

/** Deinterleaved float payload for a single channel. */
function floatPayload(samples: number, seed: number): Uint8Array {
  const floats = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    floats[i] = Math.sin((seed + i) / 20) * 0.5;
  }
  return new Uint8Array(floats.buffer);
}

export interface InitFormat {
  sampleRate?: number;
  channels?: number;
  /** Defaults to sampleRate when omitted, matching how dumps usually look. */
  reverseSampleRate?: number;
  outputSampleRate?: number;
  timestampMs?: number;
}

function initMessage(format: InitFormat): Uint8Array {
  const sampleRate = format.sampleRate ?? 16000;
  const channels = format.channels ?? 1;
  return frameMessage({
    type: Event.Type.INIT,
    init: {
      sampleRate,
      outputSampleRate: format.outputSampleRate ?? sampleRate,
      reverseSampleRate: format.reverseSampleRate ?? sampleRate,
      numInputChannels: channels,
      numOutputChannels: channels,
      numReverseChannels: channels,
      ...(format.timestampMs === undefined ? {} : { timestampMs: format.timestampMs }),
    },
  });
}

export interface DumpOptions {
  frames?: number;
  sampleRate?: number;
  channels?: number;
}

/**
 * int16 dump: each capture frame is preceded by a render frame.
 *
 * Payload sizes vary enough that roughly half the `bytes` fields land on an odd
 * byteOffset once protobufjs hands back its subarray views, which is what
 * exercises the Int16Array alignment path in the decoder.
 */
export function makeInt16Dump({
  frames = 100,
  sampleRate = 16000,
  channels = 1,
}: DumpOptions = {}): ArrayBuffer {
  const perFrame = samplesPerFrame(sampleRate);
  const parts = [initMessage({ sampleRate, channels })];
  for (let i = 0; i < frames; i++) {
    parts.push(
      frameMessage({
        type: Event.Type.REVERSE_STREAM,
        reverseStream: { data: int16Payload(perFrame, channels, i) },
      })
    );
    parts.push(
      frameMessage({
        type: Event.Type.STREAM,
        stream: {
          inputData: int16Payload(perFrame, channels, i + 100),
          outputData: int16Payload(perFrame, channels, i + 200),
          delay: 40 + (i % 20),
        },
      })
    );
  }
  return concat(parts);
}

export interface FloatDumpOptions extends DumpOptions {
  /** Capture frame indices whose STREAM event omits the output stream. */
  dropOutput?: number[];
  /** Capture frame indices whose STREAM event omits the input stream. */
  dropInput?: number[];
}

/** Deinterleaved-float dump, optionally with streams missing from some frames. */
export function makeFloatDump({
  frames = 100,
  sampleRate = 16000,
  channels = 1,
  dropOutput = [],
  dropInput = [],
}: FloatDumpOptions = {}): ArrayBuffer {
  const perFrame = samplesPerFrame(sampleRate);
  const parts = [initMessage({ sampleRate, channels })];
  for (let i = 0; i < frames; i++) {
    const stream: webrtc.audioproc.IStream = { delay: 40 };
    if (!dropInput.includes(i)) {
      stream.inputChannel = Array.from({ length: channels }, (_, c) =>
        floatPayload(perFrame, i + c * 7)
      );
    }
    if (!dropOutput.includes(i)) {
      stream.outputChannel = Array.from({ length: channels }, (_, c) =>
        floatPayload(perFrame, i + 50 + c * 7)
      );
    }
    parts.push(frameMessage({ type: Event.Type.STREAM, stream }));
  }
  return concat(parts);
}

export interface SegmentSpec extends InitFormat {
  /** Capture frames (STREAM events) this segment contributes. */
  frames: number;
  /** Emit one REVERSE_STREAM per capture frame. Defaults to true. */
  reverse?: boolean;
  /**
   * REVERSE_STREAM events emitted before this segment's capture frames, with
   * no capture call of their own. A segment made only of these advances no
   * capture frames, so the next segment starts at the same frame -- which is
   * how two segments end up with the same unpack-style filename.
   */
  reverseOnlyFrames?: number;
}

/**
 * Multi-INIT dump: each spec contributes an INIT followed by its capture
 * frames. The capture frame counter runs across the whole dump rather than
 * resetting per segment, matching unpack.cc, so a segment's start frame is the
 * sum of all preceding segments' frames -- which is also the suffix
 * unpack_aecdump would put in its filenames.
 */
export function makeSegmentedDump(
  specs: SegmentSpec[],
  { float = true }: { float?: boolean } = {}
): ArrayBuffer {
  const parts: Uint8Array[] = [];
  let frameCounter = 0;

  for (const spec of specs) {
    const sampleRate = spec.sampleRate ?? 16000;
    const channels = spec.channels ?? 1;
    const reverseRate = spec.reverseSampleRate ?? sampleRate;
    const outputRate = spec.outputSampleRate ?? sampleRate;
    parts.push(initMessage(spec));

    for (let i = 0; i < (spec.reverseOnlyFrames ?? 0); i++) {
      parts.push(
        frameMessage({
          type: Event.Type.REVERSE_STREAM,
          reverseStream: float
            ? { channel: channelPayloads(samplesPerFrame(reverseRate), channels, i) }
            : { data: int16Payload(samplesPerFrame(reverseRate), channels, i) },
        })
      );
    }

    for (let i = 0; i < spec.frames; i++) {
      const seed = frameCounter;
      if (spec.reverse !== false) {
        const perReverse = samplesPerFrame(reverseRate);
        parts.push(
          frameMessage({
            type: Event.Type.REVERSE_STREAM,
            reverseStream: float
              ? { channel: channelPayloads(perReverse, channels, seed) }
              : { data: int16Payload(perReverse, channels, seed) },
          })
        );
      }

      const perInput = samplesPerFrame(sampleRate);
      const perOutput = samplesPerFrame(outputRate);
      parts.push(
        frameMessage({
          type: Event.Type.STREAM,
          stream: float
            ? {
                inputChannel: channelPayloads(perInput, channels, seed + 100),
                outputChannel: channelPayloads(perOutput, channels, seed + 200),
                delay: 40,
              }
            : {
                inputData: int16Payload(perInput, channels, seed + 100),
                outputData: int16Payload(perOutput, channels, seed + 200),
                delay: 40,
              },
        })
      );
      frameCounter++;
    }
  }

  return concat(parts);
}

export interface MetadataDumpOptions {
  frames?: number;
  sampleRate?: number;
  /** Per-frame field values; return undefined to leave the field absent. */
  delayAt?: (frame: number) => number | undefined;
  driftAt?: (frame: number) => number | undefined;
  volumeAt?: (frame: number) => number | undefined;
  keypressAt?: (frame: number) => boolean | undefined;
  /** CONFIG events emitted just before the capture frame with that index. */
  configAt?: Record<number, webrtc.audioproc.IConfig>;
  /** RUNTIME_SETTING events emitted just before the capture frame with that index. */
  runtimeSettingAt?: Record<number, webrtc.audioproc.IRuntimeSetting>;
}

/**
 * Single-segment float dump with controllable per-frame metadata and injected
 * CONFIG / RUNTIME_SETTING events. For exercising the metadata series, markers
 * and call order rather than the audio.
 */
export function makeMetadataDump({
  frames = 20,
  sampleRate = 16000,
  delayAt,
  driftAt,
  volumeAt,
  keypressAt,
  configAt = {},
  runtimeSettingAt = {},
}: MetadataDumpOptions = {}): ArrayBuffer {
  const perFrame = samplesPerFrame(sampleRate);
  const parts = [initMessage({ sampleRate, channels: 1 })];

  for (let i = 0; i < frames; i++) {
    if (configAt[i]) {
      parts.push(frameMessage({ type: Event.Type.CONFIG, config: configAt[i] }));
    }
    if (runtimeSettingAt[i]) {
      parts.push(
        frameMessage({ type: Event.Type.RUNTIME_SETTING, runtimeSetting: runtimeSettingAt[i] })
      );
    }
    parts.push(
      frameMessage({
        type: Event.Type.REVERSE_STREAM,
        reverseStream: { channel: channelPayloads(perFrame, 1, i) },
      })
    );

    const stream: webrtc.audioproc.IStream = {
      inputChannel: channelPayloads(perFrame, 1, i + 100),
      outputChannel: channelPayloads(perFrame, 1, i + 200),
    };
    const delay = delayAt ? delayAt(i) : 40;
    if (delay !== undefined) stream.delay = delay;
    const drift = driftAt?.(i);
    if (drift !== undefined) stream.drift = drift;
    const volume = volumeAt?.(i);
    if (volume !== undefined) stream.appliedInputVolume = volume;
    const keypress = keypressAt?.(i);
    if (keypress !== undefined) stream.keypress = keypress;

    parts.push(frameMessage({ type: Event.Type.STREAM, stream }));
  }

  return concat(parts);
}

/**
 * Dump built from a literal call-order string such as 'crrccr' -- 'r' for a
 * render call, 'c' for a capture call. For exercising interleavings that the
 * regular one-render-per-capture fixtures cannot express, which is the normal
 * case when the two streams run on separate hardware clocks.
 */
export function makeCallOrderDump(order: string, sampleRate = 16000): ArrayBuffer {
  const perFrame = samplesPerFrame(sampleRate);
  const parts = [initMessage({ sampleRate, channels: 1 })];
  let seed = 0;
  for (const call of order) {
    if (call === 'r') {
      parts.push(
        frameMessage({
          type: Event.Type.REVERSE_STREAM,
          reverseStream: { channel: [floatPayload(perFrame, seed++)] },
        })
      );
    } else {
      parts.push(
        frameMessage({
          type: Event.Type.STREAM,
          stream: {
            inputChannel: [floatPayload(perFrame, seed + 100)],
            outputChannel: [floatPayload(perFrame, seed + 200)],
            delay: 40,
          },
        })
      );
      seed++;
    }
  }
  return concat(parts);
}

export interface RawDumpOptions {
  /** Written verbatim, so a test can express a malformed or partial INIT. */
  init: webrtc.audioproc.IInit;
  frames?: number;
}

/**
 * Dump built from a raw INIT message, for exercising how the parser reacts to
 * values a real dump should never contain.
 *
 * Payloads are always mono and sized from the declared capture rate (falling
 * back to 16kHz), independent of the declared channel count -- a fixture should
 * not try to allocate whatever nonsense the INIT claims.
 */
export function makeRawDump({ init, frames = 4 }: RawDumpOptions): ArrayBuffer {
  const declared = init.sampleRate ?? 0;
  const rate = declared >= 1000 && declared <= 384000 ? declared : 16000;
  const perFrame = Math.max(1, Math.floor(rate / 100));
  const parts = [frameMessage({ type: Event.Type.INIT, init })];

  for (let i = 0; i < frames; i++) {
    parts.push(
      frameMessage({
        type: Event.Type.REVERSE_STREAM,
        reverseStream: { channel: [floatPayload(perFrame, i)] },
      })
    );
    parts.push(
      frameMessage({
        type: Event.Type.STREAM,
        stream: {
          inputChannel: [floatPayload(perFrame, i + 100)],
          outputChannel: [floatPayload(perFrame, i + 200)],
          delay: 40,
        },
      })
    );
  }
  return concat(parts);
}

/** One deinterleaved float payload per channel. */
function channelPayloads(samples: number, channels: number, seed: number): Uint8Array[] {
  return Array.from({ length: channels }, (_, c) => floatPayload(samples, seed + c * 7));
}

/**
 * Counts int16 payloads that land on an odd byteOffset when the dump is
 * re-read, i.e. how many would hit the unaligned path in the decoder.
 */
export function countUnalignedInt16Payloads(dump: ArrayBuffer): number {
  const view = new DataView(dump);
  let offset = 0;
  let unaligned = 0;
  while (offset < dump.byteLength) {
    const size = view.getInt32(offset, true);
    offset += 4;
    const event = Event.decode(new Uint8Array(dump, offset, size));
    const payloads = [
      event.stream?.inputData,
      event.stream?.outputData,
      event.reverseStream?.data,
    ];
    for (const payload of payloads) {
      if (payload && payload.byteLength > 0 && payload.byteOffset % 2 !== 0) {
        unaligned++;
      }
    }
    offset += size;
  }
  return unaligned;
}
