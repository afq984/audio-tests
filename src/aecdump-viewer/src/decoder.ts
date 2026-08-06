/**
 * Transitional adapter from the segment model to the flat three-stream shape
 * the V1 UI consumes. New code should use parseDump() and the segment model
 * directly; this exists so the app keeps working while the UI catches up.
 */
import { DumpSegment, TrackKind } from './dump-model.js';
import { parseDump } from './parse-dump.js';

export interface ParsedAudioStream {
  sampleRate: number;
  channels: number;
  channelData: Float32Array[];
}

export interface DecoderResult {
  reference: ParsedAudioStream;
  input: ParsedAudioStream;
  output: ParsedAudioStream;
}

const EMPTY: ParsedAudioStream = { sampleRate: 16000, channels: 1, channelData: [] };

const KINDS: TrackKind[] = ['reverse', 'input', 'ref_out'];

function sameFormats(a: DumpSegment, b: DumpSegment): boolean {
  return KINDS.every(
    (kind) =>
      a.formats[kind].sampleRate === b.formats[kind].sampleRate &&
      a.formats[kind].channels === b.formats[kind].channels
  );
}

/**
 * Consecutive segments from the start that share the first segment's formats.
 *
 * A new INIT does not imply a new audio format: AudioProcessingImpl writes one
 * on every InitializeLocked, and ApplyConfig triggers that with the unchanged
 * api_format whenever submodule state changes. So an ordinary config change
 * mid-call splits the dump into segments that are still one continuous stream,
 * and stopping at the first of them would hide most of the audio.
 */
function compatibleRun(segments: DumpSegment[]): DumpSegment[] {
  const run: DumpSegment[] = [];
  for (const segment of segments) {
    if (run.length > 0 && !sameFormats(run[0], segment)) break;
    run.push(segment);
  }
  return run;
}

function streamFrom(run: DumpSegment[], kind: TrackKind): ParsedAudioStream {
  const base = run[0];
  if (!base) return EMPTY;
  const format = base.formats[kind];
  const samplesPerFrame = Math.floor(format.sampleRate / 100);

  const channels: Float32Array[] = Array.from(
    { length: format.channels },
    () => new Float32Array(0)
  );

  const parts: Array<{ offset: number; data: Float32Array[] }> = [];
  let end = 0;
  for (const segment of run) {
    const track = segment.tracks.find((t) => t.kind === kind);
    if (!track) continue;
    // reverse is not on the capture timeline, so it can only be concatenated,
    // which is what V1 did. The capture-aligned streams keep their positions.
    const offset =
      kind === 'reverse' ? end : (segment.startFrame - base.startFrame) * samplesPerFrame;
    parts.push({ offset, data: track.channelData });
    end = Math.max(end, offset + (track.channelData[0]?.length ?? 0));
  }
  if (parts.length === 0) {
    // A stream that never carried data has no track. The V1 shape still
    // expects one entry per channel, so give it empty ones -- callers test
    // channelData[0].length, not just the list length.
    return { sampleRate: format.sampleRate, channels: format.channels, channelData: channels };
  }

  const merged = channels.map(() => new Float32Array(end));
  for (const part of parts) {
    for (let c = 0; c < merged.length; c++) {
      const source = part.data[c];
      if (source) merged[c].set(source, part.offset);
    }
  }
  return { sampleRate: format.sampleRate, channels: format.channels, channelData: merged };
}

export function parseAecDump(arrayBuffer: ArrayBuffer): DecoderResult {
  const dump = parseDump(arrayBuffer);
  for (const warning of dump.warnings) {
    console.warn(`parseAecDump: ${warning}`);
  }

  // V1 can only show one format at a time, so it shows every segment up to the
  // first genuine format change. Previously a re-INIT was ignored and the
  // following audio was concatenated at the old rate, silently corrupting the
  // timeline. The segment model is the real fix.
  const run = compatibleRun(dump.segments);
  if (run.length < dump.segments.length) {
    console.warn(
      `parseAecDump: the audio format changes at capture frame ` +
        `${dump.segments[run.length].startFrame}; showing only what precedes it. ` +
        `The dump has ${dump.segments.length} segments in total.`
    );
  }

  console.log(`parseAecDump: Successfully parsed ${dump.eventCount} events.`);

  return {
    reference: streamFrom(run, 'reverse'),
    input: streamFrom(run, 'input'),
    output: streamFrom(run, 'ref_out'),
  };
}
