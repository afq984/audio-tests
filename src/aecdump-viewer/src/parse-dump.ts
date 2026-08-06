import { webrtc } from './proto/debug.js';
import {
  CALL_CAPTURE,
  CALL_RENDER,
  CallOrderSegment,
  DumpSegment,
  DumpTrack,
  FRAMES_PER_SECOND,
  Marker,
  MetadataSeries,
  ParsedDump,
  SegmentFormat,
  TrackKind,
  framesToSeconds,
} from './dump-model.js';

const Event = webrtc.audioproc.Event;

/**
 * Collects one per-capture-frame value, growing as frames arrive and recording
 * which frames actually carried the field. Stays null until the first value, so
 * a dump that never reports a field yields null rather than an array of zeros.
 */
class SeriesCollector {
  private values: number[] = [];
  private present: number[] = [];
  private seen = false;

  record(frame: number, value: number) {
    this.seen = true;
    while (this.values.length < frame) {
      this.values.push(0);
      this.present.push(0);
    }
    this.values[frame] = value;
    this.present[frame] = 1;
  }

  finish(frameCount: number): { values: Int32Array; present: Uint8Array } | null {
    if (!this.seen) return null;
    const values = new Int32Array(frameCount);
    const present = new Uint8Array(frameCount);
    const limit = Math.min(frameCount, this.values.length);
    for (let i = 0; i < limit; i++) {
      values[i] = this.values[i];
      present[i] = this.present[i];
    }
    return { values, present };
  }
}

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
    // Truncate, because unpack.cc computes this with C++ integer division
    // (`sample_rate / 100`). Only matters for rates that are not a multiple of
    // 100, which APM does not use, but divergence here would be silent.
    return Math.floor(this.sampleRate / FRAMES_PER_SECOND);
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
  /** Render/capture call order, one char code per event, in file order. */
  readonly calls: number[] = [];
  /**
   * Capture calls completed before each render call in this segment; index is
   * the render frame. See DumpSegment.renderToCaptureFrame.
   */
  readonly renderToCapture: number[] = [];
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
        timeline: kind === 'reverse' ? 'render' : 'capture',
        id: `init${this.initIndex}:${kind}`,
        name: `${TRACK_PREFIX[kind]}${this.startFrame}.wav`,
        initIndex: this.initIndex,
        sampleRate: acc.sampleRate,
        channels: acc.channels,
        channelData,
        startFrame: this.startFrame,
        // Native position only. A render track is NOT projected onto capture
        // coordinates here: the call order records serialization order, not
        // clock measurements, so any warp is an estimate applied at display
        // time through a TrackTransform.
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
      renderToCaptureFrame:
        this.renderToCapture.length > 0 ? Int32Array.from(this.renderToCapture) : null,
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

/** Reads an optional proto2 scalar that may be absent, using own-property presence. */
function optionalScalar(message: object, field: string): number | boolean | string | undefined {
  if (!Object.prototype.hasOwnProperty.call(message, field)) return undefined;
  const value = (message as Record<string, unknown>)[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** Field order mirrors unpack.cc's PRINT_CONFIG sequence in settings.txt. */
const CONFIG_FIELDS = [
  'aecEnabled',
  'aecDelayAgnosticEnabled',
  'aecDriftCompensationEnabled',
  'aecExtendedFilterEnabled',
  'aecSuppressionLevel',
  'agcEnabled',
  'agcMode',
  'agcLimiterEnabled',
  'noiseRobustAgcEnabled',
  'hpfEnabled',
  'nsEnabled',
  'nsLevel',
  'transientSuppressionEnabled',
  'preAmplifierEnabled',
  'preAmplifierFixedGainFactor',
  'experimentsDescription',
  // Upstream documents this as more likely to be current than the individual
  // fields above; it arrived with the proto sync.
  'apiConfigString',
];

const RUNTIME_SETTING_FIELDS = [
  'capturePreGain',
  'customRenderProcessingSetting',
  'captureFixedPostGain',
  'playoutVolumeChange',
  'captureOutputUsed',
  'capturePostGain',
];

function presentFields(message: object, fields: string[]): Array<[string, string]> {
  const detail: Array<[string, string]> = [];
  for (const field of fields) {
    const value = optionalScalar(message, field);
    if (value !== undefined) detail.push([field, String(value)]);
  }
  return detail;
}

/** Rates APM could plausibly run at; outside this an INIT is not believable. */
const MIN_SAMPLE_RATE = 1000;
const MAX_SAMPLE_RATE = 384000;
/** Well above any real capture device, and low enough to bound allocations. */
const MAX_CHANNELS = 32;

const DEFAULT_SAMPLE_RATE = 16000;

/**
 * Reads the formats out of an INIT, reporting rather than papering over values
 * that cannot be right.
 *
 * unpack.cc falls back to the capture rate for the reverse and output rates
 * only; it uses the capture rate and every channel count verbatim. Silently
 * substituting a plausible-looking value for a missing capture rate would
 * misdecode the whole segment with no indication, so anything substituted here
 * is warned about, and a channel count that would drive a huge allocation
 * rejects the segment instead.
 */
function formatsFromInit(
  init: webrtc.audioproc.IInit,
  initIndex: number,
  warnings: string[]
): Record<TrackKind, SegmentFormat> | null {
  const rawRate = init.sampleRate ?? 0;
  let sampleRate = rawRate;
  if (!(rawRate >= MIN_SAMPLE_RATE && rawRate <= MAX_SAMPLE_RATE)) {
    warnings.push(
      `Init #${initIndex} reports an implausible capture sample rate (${rawRate}); ` +
        `assuming ${DEFAULT_SAMPLE_RATE}Hz, so its timing may be wrong.`
    );
    sampleRate = DEFAULT_SAMPLE_RATE;
  }

  const rate = (value: number | null | undefined, label: string): number => {
    const candidate = value ?? 0;
    if (candidate === 0) return sampleRate; // upstream's documented fallback
    if (candidate >= MIN_SAMPLE_RATE && candidate <= MAX_SAMPLE_RATE) return candidate;
    warnings.push(
      `Init #${initIndex} reports an implausible ${label} sample rate (${candidate}); ` +
        `using the capture rate instead.`
    );
    return sampleRate;
  };

  const channelCount = (value: number | null | undefined, label: string): number | null => {
    const candidate = value ?? 0;
    if (candidate === 0) return 1; // upstream treats an absent count as mono
    if (candidate > 0 && candidate <= MAX_CHANNELS) return candidate;
    warnings.push(
      `Init #${initIndex} reports ${candidate} ${label} channels, which cannot be right; ` +
        `skipping the segment rather than misdecoding it.`
    );
    return null;
  };

  const inputChannels = channelCount(init.numInputChannels, 'input');
  const outputChannels = channelCount(init.numOutputChannels, 'output');
  const reverseChannels = channelCount(init.numReverseChannels, 'reverse');
  if (inputChannels === null || outputChannels === null || reverseChannels === null) {
    return null;
  }

  return {
    reverse: { sampleRate: rate(init.reverseSampleRate, 'reverse'), channels: reverseChannels },
    input: { sampleRate, channels: inputChannels },
    ref_out: { sampleRate: rate(init.outputSampleRate, 'output'), channels: outputChannels },
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

  const markers: Marker[] = [];
  const callOrder: CallOrderSegment[] = [];
  const delay = new SeriesCollector();
  const drift = new SeriesCollector();
  const appliedInputVolume = new SeriesCollector();
  const keypress = new SeriesCollector();

  let offset = 0;
  let eventCount = 0;
  let captureFrameCount = 0;
  let initCount = 0;
  let current: SegmentBuilder | null = null;

  const closeCurrent = () => {
    if (!current) return;
    current.frameCount = captureFrameCount - current.startFrame;
    segments.push(current.finish());
    callOrder.push({
      startFrame: current.startFrame,
      calls: Uint8Array.from(current.calls),
    });
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
        const formats = formatsFromInit(init, initCount, warnings);
        if (!formats) break;
        const timestampMs = optionalInt64(init, 'timestampMs');
        current = new SegmentBuilder(initCount, captureFrameCount, formats, timestampMs);
        markers.push({
          kind: 'init',
          frame: captureFrameCount,
          time: framesToSeconds(captureFrameCount),
          label: `Init #${initCount}`,
          detail: [
            ['input', `${formats.input.sampleRate}Hz x${formats.input.channels}`],
            ['output', `${formats.ref_out.sampleRate}Hz x${formats.ref_out.channels}`],
            ['reverse', `${formats.reverse.sampleRate}Hz x${formats.reverse.channels}`],
            ...(timestampMs === undefined
              ? []
              : ([['timestamp_ms', String(timestampMs)]] as Array<[string, string]>)),
          ],
        });
        break;
      }

      case Event.Type.CONFIG: {
        const config = event.config;
        if (!config) break;
        markers.push({
          kind: 'config',
          frame: captureFrameCount,
          time: framesToSeconds(captureFrameCount),
          // Upstream logs this as "APM re-config at frame: N".
          label: 'APM re-config',
          detail: presentFields(config, CONFIG_FIELDS),
        });
        break;
      }

      case Event.Type.RUNTIME_SETTING: {
        const setting = event.runtimeSetting;
        if (!setting) break;
        const detail = presentFields(setting, RUNTIME_SETTING_FIELDS);
        markers.push({
          kind: 'runtime-setting',
          frame: captureFrameCount,
          time: framesToSeconds(captureFrameCount),
          label: detail.length > 0 ? detail[0][0] : 'runtime setting',
          detail,
        });
        break;
      }

      case Event.Type.REVERSE_STREAM: {
        const rev = event.reverseStream;
        if (!rev || !current) break;
        current.calls.push(CALL_RENDER);
        // Capture calls completed *before* this render call. Recording it
        // before appending fixes the boundary convention: a render call that
        // arrives between capture N-1 and N is tied to N, not to N-1.
        current.renderToCapture.push(captureFrameCount - current.startFrame);
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
        current.calls.push(CALL_CAPTURE);

        // The metadata series are indexed by capture frame, so they line up
        // with the audio without any extra bookkeeping.
        const delayValue = optionalScalar(stream, 'delay');
        if (typeof delayValue === 'number') delay.record(frameIndex, delayValue);
        const driftValue = optionalScalar(stream, 'drift');
        if (typeof driftValue === 'number') drift.record(frameIndex, driftValue);
        const volumeValue = optionalScalar(stream, 'appliedInputVolume');
        if (typeof volumeValue === 'number') appliedInputVolume.record(frameIndex, volumeValue);
        const keypressValue = optionalScalar(stream, 'keypress');
        if (typeof keypressValue === 'boolean') keypress.record(frameIndex, keypressValue ? 1 : 0);

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
        break;
    }
  }

  closeCurrent();

  if (segments.length === 0 && captureFrameCount > 0) {
    warnings.push('The dump contains audio but no INIT event, so its format is unknown.');
  }

  const delayResult = delay.finish(captureFrameCount);
  const driftResult = drift.finish(captureFrameCount);
  const volumeResult = appliedInputVolume.finish(captureFrameCount);
  const keypressResult = keypress.finish(captureFrameCount);

  const series: MetadataSeries = {
    delay: delayResult?.values ?? null,
    delayPresent: delayResult?.present ?? null,
    drift: driftResult?.values ?? null,
    driftPresent: driftResult?.present ?? null,
    appliedInputVolume: volumeResult?.values ?? null,
    appliedInputVolumePresent: volumeResult?.present ?? null,
    keypress: keypressResult ? Uint8Array.from(keypressResult.values) : null,
    keypressPresent: keypressResult?.present ?? null,
  };

  return { segments, captureFrameCount, eventCount, series, markers, callOrder, warnings };
}
