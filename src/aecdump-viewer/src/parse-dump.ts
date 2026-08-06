import { webrtc } from './proto/debug.js';
import {
  DumpSegment,
  DumpTrack,
  FRAMES_PER_SECOND,
  ParsedDump,
  SegmentFormat,
  TrackKind,
  framesToSeconds,
} from './dump-model.js';

const Event = webrtc.audioproc.Event;

/** Upstream's default filename prefixes (`unpack.cc` FLAGS_*_file). */
const TRACK_PREFIX: Record<TrackKind, string> = {
  reverse: 'reverse',
  input: 'input',
  ref_out: 'ref_out',
};

class ChannelAccumulator {
  private chunks: Float32Array[] = [];
  private totalLength = 0;

  append(chunk: Float32Array) {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  get length() {
    return this.totalLength;
  }

  merged(): Float32Array {
    const merged = new Float32Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }
}

/**
 * Accumulates one stream for the duration of a segment. Positions are relative
 * to the segment start, so a segment that begins at capture frame 1200 holds
 * sample 0 at that frame.
 */
class StreamAccumulator {
  readonly channelAccumulators: ChannelAccumulator[];

  constructor(readonly sampleRate: number, readonly channels: number) {
    this.channelAccumulators = Array.from({ length: channels }, () => new ChannelAccumulator());
  }

  get samplesPerFrame() {
    return Math.round(this.sampleRate / FRAMES_PER_SECOND);
  }

  get hasData() {
    return this.channelAccumulators.some((acc) => acc.length > 0);
  }

  /** Pads every channel with silence up to `targetLength`. */
  padTo(targetLength: number) {
    for (const acc of this.channelAccumulators) {
      const missing = targetLength - acc.length;
      if (missing > 0) acc.append(new Float32Array(missing));
    }
  }

  appendInterleavedInt16(bytes: Uint8Array) {
    // protobufjs hands back a view into the dump buffer at an arbitrary
    // byteOffset, but Int16Array requires 2-byte alignment. Copy when needed.
    let int16: Int16Array;
    if (bytes.byteOffset % 2 === 0) {
      int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    } else {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      int16 = new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
    }
    // Drop any trailing partial frame rather than failing the whole parse.
    const numSamples = Math.floor(int16.length / this.channels);
    const chunks = Array.from({ length: this.channels }, () => new Float32Array(numSamples));

    let index = 0;
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < this.channels; c++) {
        chunks[c][i] = int16[index++] / 32768.0;
      }
    }
    for (let c = 0; c < this.channels; c++) {
      this.channelAccumulators[c].append(chunks[c]);
    }
  }

  appendDeinterleavedFloat(channelsBytes: Uint8Array[]) {
    const actualChannels = Math.min(this.channels, channelsBytes.length);
    for (let c = 0; c < actualChannels; c++) {
      const bytes = channelsBytes[c];
      let floatData: Float32Array;
      if (bytes.byteOffset % 4 === 0) {
        floatData = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      } else {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        floatData = new Float32Array(copy.buffer, 0, copy.byteLength / 4);
      }
      this.channelAccumulators[c].append(floatData);
    }
  }
}

/** A segment under construction. */
class SegmentBuilder {
  readonly accumulators: Record<TrackKind, StreamAccumulator>;
  frameCount = 0;

  constructor(
    readonly initIndex: number,
    readonly startFrame: number,
    readonly formats: Record<TrackKind, SegmentFormat>,
    readonly timestampMs?: number
  ) {
    this.accumulators = {
      reverse: new StreamAccumulator(formats.reverse.sampleRate, formats.reverse.channels),
      input: new StreamAccumulator(formats.input.sampleRate, formats.input.channels),
      ref_out: new StreamAccumulator(formats.ref_out.sampleRate, formats.ref_out.channels),
    };
  }

  /** Position within this segment, in samples, for a global capture frame. */
  offsetFor(kind: TrackKind, globalFrame: number): number {
    return (globalFrame - this.startFrame) * this.accumulators[kind].samplesPerFrame;
  }

  finish(): DumpSegment {
    const tracks: DumpTrack[] = [];
    for (const kind of ['reverse', 'input', 'ref_out'] as TrackKind[]) {
      const acc = this.accumulators[kind];
      if (!acc.hasData) continue;
      // Padding happens before an append, so a stream whose last frames were
      // missing would end short. Extend the capture-aligned streams to the
      // segment length. `reverse` is not on the capture timeline -- it has its
      // own event rate -- so it is left at its natural length.
      if (kind !== 'reverse') {
        acc.padTo(this.frameCount * acc.samplesPerFrame);
      }
      const channelData = acc.channelAccumulators.map((c) => c.merged());
      const frames = channelData[0]?.length ?? 0;
      tracks.push({
        kind,
        name: `${TRACK_PREFIX[kind]}${this.startFrame}.wav`,
        sampleRate: acc.sampleRate,
        channels: acc.channels,
        channelData,
        startFrame: this.startFrame,
        startTime: framesToSeconds(this.startFrame),
        duration: frames / acc.sampleRate,
      });
    }

    return {
      initIndex: this.initIndex,
      startFrame: this.startFrame,
      frameCount: this.frameCount,
      timestampMs: this.timestampMs,
      formats: this.formats,
      tracks,
    };
  }
}

/**
 * Reads an optional proto2 int64 that may be absent.
 *
 * protobufjs static modules keep field defaults on the prototype and only set
 * own properties for fields actually present on the wire, so an absent
 * timestamp reads as 0 rather than null. Test presence, not value. The value
 * itself is a Long when the runtime has long support, and a number otherwise.
 */
function optionalInt64(message: object, field: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(message, field)) return undefined;
  const value = (message as Record<string, unknown>)[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const asLong = value as { toNumber?: () => number };
  return typeof asLong.toNumber === 'function' ? asLong.toNumber() : Number(value);
}

function formatsFromInit(init: webrtc.audioproc.IInit): Record<TrackKind, SegmentFormat> {
  const sampleRate = init.sampleRate || 16000;
  return {
    // unpack.cc falls back to the capture rate when these are absent or zero.
    reverse: {
      sampleRate: init.reverseSampleRate || sampleRate,
      channels: init.numReverseChannels || 1,
    },
    input: {
      sampleRate,
      channels: init.numInputChannels || 1,
    },
    ref_out: {
      sampleRate: init.outputSampleRate || sampleRate,
      channels: init.numOutputChannels || 1,
    },
  };
}

/**
 * Parses an aecdump into positioned segments and tracks.
 *
 * The dump is a sequence of [int32 little-endian length][Event protobuf]
 * records. Capture frames are counted across the whole dump, never reset per
 * segment, so a segment's start frame doubles as its filename suffix.
 */
export function parseDump(arrayBuffer: ArrayBuffer): ParsedDump {
  const view = new DataView(arrayBuffer);
  const warnings: string[] = [];
  const segments: DumpSegment[] = [];

  let offset = 0;
  let eventCount = 0;
  let captureFrameCount = 0;
  let initCount = 0;
  let current: SegmentBuilder | null = null;

  const closeCurrent = () => {
    if (!current) return;
    current.frameCount = captureFrameCount - current.startFrame;
    segments.push(current.finish());
    current = null;
  };

  while (offset < arrayBuffer.byteLength) {
    if (offset + 4 > arrayBuffer.byteLength) {
      warnings.push('Unexpected end of file while reading a message size.');
      break;
    }
    const size = view.getInt32(offset, true);
    offset += 4;

    if (size < 0 || offset + size > arrayBuffer.byteLength) {
      warnings.push('Unexpected end of file while reading a message payload.');
      break;
    }

    const eventBytes = new Uint8Array(arrayBuffer, offset, size);
    offset += size;

    let event: webrtc.audioproc.Event;
    try {
      event = Event.decode(eventBytes);
    } catch (e) {
      warnings.push(`Skipped an undecodable event at offset ${offset - size - 4}: ${e}`);
      continue;
    }

    eventCount++;

    switch (event.type) {
      case Event.Type.INIT: {
        const init = event.init;
        if (!init) break;
        closeCurrent();
        initCount++;
        current = new SegmentBuilder(
          initCount,
          captureFrameCount,
          formatsFromInit(init),
          optionalInt64(init, 'timestampMs')
        );
        break;
      }

      case Event.Type.REVERSE_STREAM: {
        const rev = event.reverseStream;
        if (!rev || !current) break;
        const acc = current.accumulators.reverse;
        if (rev.data && rev.data.length > 0) {
          acc.appendInterleavedInt16(rev.data);
        } else if (rev.channel && rev.channel.length > 0) {
          acc.appendDeinterleavedFloat(rev.channel);
        }
        break;
      }

      case Event.Type.STREAM: {
        const stream = event.stream;
        // The frame counter advances for every STREAM event, even one that
        // arrives before the first INIT, so names stay aligned with upstream.
        const frameIndex = captureFrameCount++;
        if (!stream || !current) break;

        // Pad up to this frame's position before appending, so an event that
        // carries only one stream does not shift the other out of lockstep.
        const input = current.accumulators.input;
        if (stream.inputData && stream.inputData.length > 0) {
          input.padTo(current.offsetFor('input', frameIndex));
          input.appendInterleavedInt16(stream.inputData);
        } else if (stream.inputChannel && stream.inputChannel.length > 0) {
          input.padTo(current.offsetFor('input', frameIndex));
          input.appendDeinterleavedFloat(stream.inputChannel);
        }

        const output = current.accumulators.ref_out;
        if (stream.outputData && stream.outputData.length > 0) {
          output.padTo(current.offsetFor('ref_out', frameIndex));
          output.appendInterleavedInt16(stream.outputData);
        } else if (stream.outputChannel && stream.outputChannel.length > 0) {
          output.padTo(current.offsetFor('ref_out', frameIndex));
          output.appendDeinterleavedFloat(stream.outputChannel);
        }
        break;
      }

      default:
        // Config and RuntimeSetting are modelled separately; see the metadata
        // series and markers.
        break;
    }
  }

  closeCurrent();

  if (segments.length === 0 && captureFrameCount > 0) {
    warnings.push('The dump contains audio but no INIT event, so its format is unknown.');
  }

  return { segments, captureFrameCount, eventCount, warnings };
}
