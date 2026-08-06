/**
 * The shape a parsed aecdump takes once it is on a timeline.
 *
 * The model mirrors what `rtc_tools/unpack_aecdump` produces, because that is
 * the tool this viewer replaces and the vocabulary its users already have:
 *
 *   - Every INIT event starts a new *segment*. Upstream closes and reopens its
 *     WAV files there, because a WAV cannot change sample rate or channel count
 *     mid-file. The same constraint applies to an AudioBuffer.
 *   - Within a segment each stream becomes a *track*, named the way upstream
 *     names its files: `reverse`, `input` (microphone capture) and `ref_out`
 *     (the processed output -- note that upstream's "ref" means output, not the
 *     playout reference).
 *   - The filename suffix is the cumulative capture frame count at the INIT, so
 *     a track's name also states where it starts on the capture timeline.
 */

/** One APM frame is 10ms; upstream fixes this (`sample_rate / 100`). */
export const FRAME_MS = 10;
export const FRAMES_PER_SECOND = 1000 / FRAME_MS;

/**
 * Upstream's stream names. `ref_out` is the processed output; the playout
 * reference is `reverse`.
 */
export type TrackKind = 'reverse' | 'input' | 'ref_out';

export interface DumpTrack {
  kind: TrackKind;
  /** unpack_aecdump-style name, e.g. `input1200.wav`. */
  name: string;
  sampleRate: number;
  channels: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channelData: Float32Array[];
  /** Capture frame index where this track begins. */
  startFrame: number;
  /** Seconds from the start of the dump's capture timeline. */
  startTime: number;
  /** Track duration in seconds. */
  duration: number;
}

export interface SegmentFormat {
  sampleRate: number;
  channels: number;
}

export interface DumpSegment {
  /** 1-based, matching unpack.cc's `Init #N` numbering. */
  initIndex: number;
  /** Cumulative capture frame count when this INIT was seen. */
  startFrame: number;
  /** Capture frames belonging to this segment. */
  frameCount: number;
  /** Wall-clock stamp from the INIT event, when the dump carries one. */
  timestampMs?: number;
  formats: Record<TrackKind, SegmentFormat>;
  /** Only streams that carried data; a stream that never appeared is absent. */
  tracks: DumpTrack[];
}

/**
 * Per-capture-frame values from the Stream events, indexed by capture frame.
 *
 * These are what `unpack_aecdump --full` writes as headerless `delay.int32`,
 * `drift.int32`, `level.int32` and `keypress.bool`. They are the reason to open
 * an aecdump rather than a pair of WAVs, so they are always collected here
 * rather than hidden behind a flag.
 *
 * A field is null when no event in the dump carried it. Frames where the field
 * was absent hold the `*Present` bit as 0, so a gap is distinguishable from a
 * genuine zero.
 */
export interface MetadataSeries {
  /** Reported render-capture delay in ms, per capture frame. */
  delay: Int32Array | null;
  delayPresent: Uint8Array | null;
  /** Reported clock drift, per capture frame. */
  drift: Int32Array | null;
  driftPresent: Uint8Array | null;
  /** Applied input (microphone) volume, per capture frame. */
  appliedInputVolume: Int32Array | null;
  appliedInputVolumePresent: Uint8Array | null;
  /** Keypress flag, per capture frame. */
  keypress: Uint8Array | null;
  keypressPresent: Uint8Array | null;
}

export type MarkerKind = 'init' | 'config' | 'runtime-setting';

/**
 * A point event on the capture timeline. Upstream records these in
 * `settings.txt` ("APM re-config at frame: N") and as Audacity label tracks.
 */
export interface Marker {
  kind: MarkerKind;
  /** Capture frame the event was seen at. */
  frame: number;
  /** Seconds from the start of the capture timeline. */
  time: number;
  /** Short label, e.g. `Init #2` or `capture_pre_gain`. */
  label: string;
  /** Field/value pairs, in the order upstream prints them. */
  detail: Array<[string, string]>;
}

/**
 * The render/capture call order for one segment: one character per event in
 * file order, `r` for REVERSE_STREAM and `c` for STREAM. This is exactly the
 * byte stream `unpack_aecdump --full` writes to `callorder<suffix>.char`, and
 * the input to render/capture drift analysis.
 */
export interface CallOrderSegment {
  /** Capture frame the segment starts at; matches DumpSegment.startFrame. */
  startFrame: number;
  calls: Uint8Array;
}

export const CALL_RENDER = 'r'.charCodeAt(0);
export const CALL_CAPTURE = 'c'.charCodeAt(0);

export interface ParsedDump {
  segments: DumpSegment[];
  /** Total capture frames across the dump; the length of the capture timeline. */
  captureFrameCount: number;
  /** Total events read, including ones the parser does not model. */
  eventCount: number;
  series: MetadataSeries;
  markers: Marker[];
  callOrder: CallOrderSegment[];
  /** Non-fatal problems worth surfacing rather than logging and forgetting. */
  warnings: string[];
}

/** Seconds spanned by a capture frame count. */
export function framesToSeconds(frames: number): number {
  return frames / FRAMES_PER_SECOND;
}

/** All tracks across all segments, in timeline order. */
export function allTracks(dump: ParsedDump): DumpTrack[] {
  return dump.segments.flatMap((segment) => segment.tracks);
}

/** The dump's full capture-timeline duration in seconds. */
export function dumpDuration(dump: ParsedDump): number {
  const trackEnd = allTracks(dump).reduce(
    (max, track) => Math.max(max, track.startTime + track.duration),
    0
  );
  return Math.max(framesToSeconds(dump.captureFrameCount), trackEnd);
}
