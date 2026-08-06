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

function streamFrom(segment: DumpSegment | undefined, kind: TrackKind): ParsedAudioStream {
  if (!segment) return EMPTY;
  const format = segment.formats[kind];
  const track = segment.tracks.find((t) => t.kind === kind);
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    // A stream that never carried data has no track. The V1 shape still
    // expects one entry per channel, so give it empty ones -- callers test
    // channelData[0].length, not just the list length.
    channelData: track
      ? track.channelData
      : Array.from({ length: format.channels }, () => new Float32Array(0)),
  };
}

export function parseAecDump(arrayBuffer: ArrayBuffer): DecoderResult {
  const dump = parseDump(arrayBuffer);
  for (const warning of dump.warnings) {
    console.warn(`parseAecDump: ${warning}`);
  }

  // V1 has no way to show more than one format, so it shows the first segment.
  // Previously a re-INIT was ignored and the following audio was concatenated
  // at the old rate, which silently corrupted the timeline; showing one intact
  // segment is at least coherent. The segment model is the real fix.
  if (dump.segments.length > 1) {
    console.warn(
      `parseAecDump: dump has ${dump.segments.length} segments (the format changes mid-dump); ` +
        `showing the first. Segments start at capture frames ` +
        `${dump.segments.map((s) => s.startFrame).join(', ')}.`
    );
  }

  const first = dump.segments[0];
  console.log(`parseAecDump: Successfully parsed ${dump.eventCount} events.`);

  return {
    reference: streamFrom(first, 'reverse'),
    input: streamFrom(first, 'input'),
    output: streamFrom(first, 'ref_out'),
  };
}
