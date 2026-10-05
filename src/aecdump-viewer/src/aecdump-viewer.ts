import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { parseDump } from './parse-dump.js';
import {
  DumpTrack,
  FRAMES_PER_SECOND,
  FRAME_MS,
  Marker,
  ParsedDump,
  allTracks,
  dumpDuration,
} from './dump-model.js';
import {
  DEFAULT_ALLOWED_LATENESS_FRAMES,
  EventStream,
  EventTimeLayout,
  SeekResolution,
  eventFramesToSeconds,
  layOutEventTime,
  runsFor,
  toEventFrame,
  toNativeFrame,
} from './event-time.js';
import {
  IDENTITY_TRANSFORM,
  TrackTransform,
  makeTransform,
  toDisplayTime,
  toEventFrame as displayToEventFrame,
} from './timeline.js';
import { DriftAnalysis, analyzeDrift } from './drift-analysis.js';
import { audioBufferToWav } from './wav-helper.js';

/**
 * Facade exposing per-track transport state for deterministic inspection and E2E tests.
 */
export interface TrackTransportFacade {
  getCurrentTime: () => number;
  getDuration: () => number;
  getMuted: () => boolean;
}

interface TrackWaveformCache {
  key: string;
  unplayedCanvas: HTMLCanvasElement;
  playedCanvas: HTMLCanvasElement;
}

interface OffscreenPlotCache {
  key: string;
  canvas: HTMLCanvasElement;
}

/**
 * One row in the viewer.
 *
 * Tracks come from the dump rather than a fixed set: a dump has as many as its
 * INIT events produced, they are named the way `unpack_aecdump` names its
 * files, and a stream that never carried data has no row at all.
 */
interface UiTrack {
  /** Stable identity from the parser: `init1:reverse`. */
  id: string;
  /** unpack-style name, e.g. `reverse1200.wav`. */
  name: string;
  /** Safe for an element id and a CSS selector; `id` contains a colon. */
  domId: string;
  source: DumpTrack;
  /** Largest absolute sample across every channel, in [0, 1]. */
  peak: number;
  /**
   * Vertical scale for drawing only; playback and export are untouched.
   * 1 draws at honest [-1, 1] scale.
   */
  gain: number;
  /** Whether vertical fit zoom (1 / peak) is currently active. */
  zoomed: boolean;
  /** Decoded WebAudio buffer for playback and WAV export. */
  audioBuffer: AudioBuffer;
  /** Current position on the track's own native frame axis. */
  currentNativeFrame: number;
  /** Native position relative to track start, in seconds [0, source.duration]. */
  currentTime: number;
  /** Native frame when playback started. */
  playStartNativeFrame: number;
  /** True unless this track is the single audible track. */
  muted: boolean;
  /** Transport facade for inspecting per-track clock, duration, and mute state. */
  transport: TrackTransportFacade;
  /** Cached offscreen waveform bitmaps for O(1) cursor redraws. */
  waveformCache: TrackWaveformCache | null;
  url: string | null;
}

/**
 * Maps a capture-timeline marker frame to the event-time axis, snapping
 * unplaced frames (before the first valid INIT, during a rejected INIT, or
 * in a zero-capture segment) to the nearest placed slot instead of falling
 * back to the native frame axis.
 */
function snapCaptureToEventFrame(layout: EventTimeLayout, nativeFrame: number): number {
  const exact = toEventFrame(layout, 'capture', nativeFrame);
  if (exact !== null) return exact;
  const runs = layout.captureRuns;
  if (runs.length === 0) return 0;
  const next = runs.find((r) => r.nativeStartFrame >= nativeFrame);
  if (next) return next.eventStartFrame;
  const last = runs[runs.length - 1];
  return last.eventStartFrame + last.frameCount;
}

/** Peak as dBFS, or a dash for digital silence. */
function formatDbfs(peak: number): string {
  if (peak <= 0) return '-inf dBFS';
  return `${(20 * Math.log10(peak)).toFixed(1)} dBFS`;
}

function peakOf(track: DumpTrack): number {
  let peak = 0;
  for (const channel of track.channelData) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

@customElement('aecdump-viewer')
export class AecDumpViewer extends LitElement {
  @state() private loading = false;
  @state() private loadingStatus = '';
  @state() private isPlaying = false;
  @state() private duration = 0;
  @state() private currentTime = 0;

  @state() private tracks: UiTrack[] = [];
  @state() private warnings: string[] = [];
  @state() private audibleTrackId: string | null = null;

  @state() private allowedLatenessFrames: number = DEFAULT_ALLOWED_LATENESS_FRAMES;
  @state() private renderOffsetMs = 0;
  @state() private seekResolution: SeekResolution | null = null;
  @state() private selectedMarker: Marker | null = null;

  private parsedDump: ParsedDump | null = null;
  private layout: EventTimeLayout | null = null;
  private driftAnalyses: DriftAnalysis[] = [];
  private renderTransform: TrackTransform = IDENTITY_TRANSFORM;
  private displayStart = 0;
  private displayEnd = 0;
  private cursorDisplaySec = 0;
  private captureNativeFrame = 0;
  private renderNativeFrame = 0;
  private driftCache: OffscreenPlotCache | null = null;
  private seriesCache: OffscreenPlotCache | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private audioCtx: AudioContext | null = null;
  private activeSourceNode: AudioBufferSourceNode | null = null;
  private activeGainNode: GainNode | null = null;
  private playStartCtxTime = 0;
  private rafId: number | null = null;
  private draggingContainer: HTMLElement | null = null;

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #333;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    header {
      margin-bottom: 24px;
      border-bottom: 1px solid #eee;
      padding-bottom: 16px;
    }

    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      color: #1a73e8;
    }

    .description {
      margin: 0;
      color: #666;
      font-size: 14px;
    }

    .dropzone {
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 32px 20px;
      text-align: center;
      background: #fafafa;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
      margin-bottom: 20px;
    }

    .dropzone:hover,
    .dropzone.dragover {
      border-color: #1a73e8;
      background: #f1f3f4;
    }

    .dropzone p {
      margin: 0;
      font-size: 16px;
      color: #5f6368;
    }

    .dropzone input {
      display: none;
    }

    .status {
      padding: 10px 15px;
      border-radius: 4px;
      background: #e8f0fe;
      color: #1a73e8;
      margin-bottom: 20px;
      font-size: 14px;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
      background: #f8f9fa;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: #3c4043;
    }

    .control-group input[type='number'] {
      width: 68px;
      padding: 4px 6px;
      border: 1px solid #dadce0;
      border-radius: 4px;
      font-size: 13px;
      font-family: monospace;
    }

    .control-hint {
      color: #5f6368;
      font-family: monospace;
      font-size: 12px;
    }

    .seek-badge {
      font-family: monospace;
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 4px;
      background: #e8eaed;
      color: #3c4043;
    }

    .seek-badge.warn {
      background: #fef7e0;
      color: #b06000;
      border: 1px solid #fdd663;
    }

    button,
    a.button {
      background: #1a73e8;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      font-size: 14px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }

    button:hover,
    a.button:hover {
      background: #1557b0;
    }

    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    button.secondary,
    a.button.secondary {
      background: #f1f3f4;
      color: #3c4043;
      border: 1px solid #dadce0;
    }

    button.secondary:hover,
    a.button.secondary:hover {
      background: #e8eaed;
    }

    .time-display {
      font-family: monospace;
      font-size: 14px;
      color: #5f6368;
      margin-left: auto;
    }

    .tracks-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 20px;
    }

    .track-card,
    .diagnostic-card {
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: white;
      overflow: hidden;
      box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.2), 0 1px 3px 1px rgba(60, 64, 67, 0.1);
    }

    .track-header,
    .diagnostic-header {
      background: #f8f9fa;
      padding: 8px 14px;
      border-bottom: 1px solid #dadce0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }

    .track-title,
    .diagnostic-title {
      font-weight: 600;
      font-size: 14px;
      color: #3c4043;
    }

    .track-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }

    .track-controls button,
    .track-controls a.button {
      padding: 4px 8px;
      font-size: 12px;
    }

    .track-controls button.zoom.active {
      background: #e8f0fe;
      color: #1a73e8;
      border-color: #a8c7fa;
    }

    .track-controls button.listen.active {
      background: #1a73e8;
      color: white;
      border-color: #1a73e8;
    }

    .track-meta,
    .diagnostic-badges {
      font-family: monospace;
      font-size: 12px;
      color: #5f6368;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge {
      background: #e8f0fe;
      color: #1a73e8;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: monospace;
    }

    .warnings {
      margin: 0 0 20px 0;
      padding: 10px 15px 10px 32px;
      border-radius: 4px;
      background: #fef7e0;
      color: #875900;
      border: 1px solid #fdd663;
      font-size: 13px;
    }

    .track-body,
    .diagnostic-body {
      padding: 12px 14px;
      background: #fafafa;
      position: relative;
    }

    .waveform-container,
    .chart-container {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      min-height: 80px;
      position: relative;
      cursor: ew-resize;
      user-select: none;
      overflow: hidden;
    }

    .waveform-canvas,
    .chart-canvas {
      display: block;
      width: 100%;
      height: 80px;
    }

    .chart-canvas.tall {
      height: 110px;
    }

    .diagnostics-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .markers-strip {
      position: relative;
      height: 32px;
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .marker-pin {
      position: absolute;
      top: 4px;
      transform: translateX(-50%);
      padding: 2px 6px;
      font-size: 11px;
      font-family: monospace;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
      border: 1px solid #1a73e8;
      background: #e8f0fe;
      color: #1a73e8;
      z-index: 2;
    }

    .marker-pin.active {
      background: #1a73e8;
      color: white;
      z-index: 3;
    }

    .marker-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }

    .marker-detail {
      background: white;
      border: 1px solid #dadce0;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
      font-family: monospace;
    }

    .marker-detail table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
    }

    .marker-detail td {
      padding: 2px 8px 2px 0;
      border-bottom: 1px solid #f1f3f4;
    }

    .marker-detail td.key {
      color: #5f6368;
      width: 220px;
    }

    .legend {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: #5f6368;
      margin-left: auto;
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
  `;

  override render() {
    const hasTracks = this.tracks.length > 0;

    return html`
      <header>
        <h1>AECDump Web Viewer</h1>
        <p class="description">
          In-browser replacement for unpack_aecdump: decodes a dump to its streams, names them the
          way unpack does, and lays them out on a shared event-time axis.
        </p>
      </header>

      <div
        class="dropzone"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
        @click=${this.triggerFileSelect}
      >
        <p>
          ${this.loading
            ? 'Parsing dump...'
            : 'Drag & drop an aecdump/protobuf file here, or click to select'}
        </p>
        <input
          type="file"
          id="fileInput"
          accept=".pb,.aecdump,.aecdump.binpb,.binpb,*"
          @change=${this.onFileSelected}
        />
      </div>

      ${this.loadingStatus ? html`<div class="status">${this.loadingStatus}</div>` : ''}
      ${this.warnings.length > 0
        ? html`
            <ul class="warnings" id="warnings">
              ${this.warnings.map((w) => html`<li>${w}</li>`)}
            </ul>
          `
        : ''}
      ${hasTracks
        ? html`
            <div class="controls">
              <button id="play-pause-btn" @click=${this.togglePlay}>
                ${this.isPlaying ? 'Pause' : 'Play'}
              </button>
              <button id="stop-btn" class="secondary" @click=${this.stopAll}>Stop</button>

              <label class="control-group" for="lateness-input">
                <span>Lateness tolerance:</span>
                <input
                  id="lateness-input"
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  .value=${String(this.allowedLatenessFrames)}
                  @input=${this.onLatenessInput}
                />
                <span class="control-hint">frames (${this.allowedLatenessFrames * FRAME_MS} ms)</span>
              </label>

              <label class="control-group" for="render-offset-input">
                <span>Render offset:</span>
                <input
                  id="render-offset-input"
                  type="number"
                  min="-5000"
                  max="5000"
                  step="10"
                  .value=${String(this.renderOffsetMs)}
                  @input=${this.onRenderOffsetInput}
                />
                <span class="control-hint">ms</span>
              </label>

              <span
                id="seek-resolution"
                class="seek-badge ${this.seekResolution && this.seekResolution !== 'exact'
                  ? 'warn'
                  : ''}"
              >
                ${this.seekResolution ? `seek: ${this.seekResolution}` : 'seek: exact'}
              </span>

              <div class="time-display">
                ${this.formatTime(this.currentTime)} / ${this.formatTime(this.duration)}
              </div>
            </div>

            <div class="tracks-container">
              ${this.tracks.map((track) => this.renderTrackCard(track))}
            </div>

            <div class="diagnostics-container">
              ${this.renderMarkersLane()} ${this.renderDriftLane()} ${this.renderSeriesLane()}
            </div>
          `
        : ''}
    `;
  }

  private renderTrackCard(track: UiTrack) {
    const audible = track.id === this.audibleTrackId;
    const zoomLabel = track.zoomed
      ? `${track.gain >= 10 ? track.gain.toFixed(0) : track.gain.toFixed(1)}\u00d7`
      : 'Fit';
    return html`
      <div class="track-card">
        <div class="track-header">
          <span class="track-title">${track.name}</span>

          <div class="track-controls">
            <span class="track-meta">
              ${track.source.sampleRate} Hz
              ${track.source.channels > 1 ? html`&times;${track.source.channels}` : ''} &middot;
              ${track.source.duration.toFixed(2)}s &middot; ${track.source.timeline} &middot; peak
              ${formatDbfs(track.peak)}
            </span>
            <button
              class="secondary zoom ${track.zoomed ? 'active' : ''}"
              id="zoom-${track.domId}"
              title="Vertical zoom. Drawing only -- playback is unchanged."
              @click=${() => this.toggleGain(track.id)}
            >
              ${zoomLabel}
            </button>
            <button
              class="secondary listen ${audible ? 'active' : ''}"
              id="listen-${track.domId}"
              @click=${() => this.setAudibleTrack(track.id)}
            >
              ${audible ? 'Listening' : 'Listen'}
            </button>
            <a
              class="button secondary download-wav"
              download=${track.name}
              href=${track.url ?? '#'}
            >
              WAV
            </a>
          </div>
        </div>
        <div class="track-body">
          <div
            class="waveform-container"
            id="waveform-${track.domId}"
            @pointerdown=${(e: PointerEvent) =>
              this.onTimelinePointerDown(e, track.source.timeline)}
          >
            <canvas class="waveform-canvas" id="canvas-${track.domId}"></canvas>
          </div>
        </div>
      </div>
    `;
  }

  private renderMarkersLane() {
    const markers = this.parsedDump?.markers ?? [];
    const span = Math.max(0.001, this.displayEnd - this.displayStart);

    return html`
      <div class="diagnostic-card" id="markers-lane">
        <div class="diagnostic-header">
          <span class="diagnostic-title">Markers &amp; Configuration Events</span>
          <div class="diagnostic-badges">
            <span class="badge">${markers.length} event${markers.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div class="diagnostic-body">
          <div class="markers-strip">
            ${markers.map((marker) => {
              const evFrame =
                this.layout !== null
                  ? snapCaptureToEventFrame(this.layout, marker.frame)
                  : marker.frame;
              const dispSec = toDisplayTime(IDENTITY_TRANSFORM, evFrame);
              const pct = Math.max(2, Math.min(98, ((dispSec - this.displayStart) / span) * 100));
              const isSelected = this.selectedMarker === marker;
              return html`
                <button
                  class="marker-pin ${isSelected ? 'active' : ''}"
                  style="left: ${pct}%"
                  title="${marker.label} @ frame ${marker.frame}"
                  @click=${() => this.selectMarker(marker)}
                >
                  ${marker.label}
                </button>
              `;
            })}
          </div>

          ${this.selectedMarker
            ? html`
                <div class="marker-detail" id="marker-detail-panel">
                  <div>
                    <strong>${this.selectedMarker.label}</strong>
                    (${this.selectedMarker.kind}, frame ${this.selectedMarker.frame},
                    ${this.selectedMarker.time.toFixed(2)}s)
                  </div>
                  ${this.selectedMarker.detail.length > 0
                    ? html`
                        <table>
                          <tbody>
                            ${this.selectedMarker.detail.map(
                              ([k, v]) => html`
                                <tr>
                                  <td class="key">${k}</td>
                                  <td class="val">${v}</td>
                                </tr>
                              `
                            )}
                          </tbody>
                        </table>
                      `
                    : ''}
                </div>
              `
            : ''}
        </div>
      </div>
    `;
  }

  private renderDriftLane() {
    const totalLeading = this.driftAnalyses.reduce((s, a) => s + a.leadingRenderFrames, 0);
    const totalTrailing = this.driftAnalyses.reduce((s, a) => s + a.trailingRenderFrames, 0);
    const gapCount = this.layout?.gaps.length ?? 0;

    return html`
      <div class="diagnostic-card" id="drift-lane">
        <div class="diagnostic-header">
          <span class="diagnostic-title">Call-Order Drift &amp; Delay</span>
          <div class="diagnostic-badges">
            <span class="badge" id="badge-leading-render">leadingRenderFrames: ${totalLeading}</span>
            <span class="badge" id="badge-trailing-render">
              trailingRenderFrames: ${totalTrailing}
            </span>
            <span class="badge" id="badge-gaps">gaps: ${gapCount}</span>
          </div>
          <div class="legend">
            <span class="legend-item">
              <span class="legend-swatch" style="background: #d93025"></span>
              Call-order drift (ms)
            </span>
            <span class="legend-item">
              <span class="legend-swatch" style="background: #1a73e8"></span>
              Stream.delay (ms)
            </span>
            <span class="legend-item">
              <span class="legend-swatch" style="background: #188038"></span>
              Stream.drift (samples)
            </span>
          </div>
        </div>
        <div class="diagnostic-body">
          <div
            class="chart-container"
            id="drift-chart-container"
            @pointerdown=${(e: PointerEvent) => this.onTimelinePointerDown(e, 'capture')}
          >
            <canvas class="chart-canvas tall" id="canvas-drift"></canvas>
          </div>
        </div>
      </div>
    `;
  }

  private renderSeriesLane() {
    const series = this.parsedDump?.series;
    const hasVolume = series?.appliedInputVolume !== null && series?.appliedInputVolume !== undefined;
    const hasKeypress = series?.keypress !== null && series?.keypress !== undefined;

    return html`
      <div class="diagnostic-card" id="series-lane">
        <div class="diagnostic-header">
          <span class="diagnostic-title">Capture Telemetry (Applied Input Volume &amp; Keypress)</span>
          <div class="legend">
            <span class="legend-item">
              <span class="legend-swatch" style="background: #9334e6"></span>
              Applied Input Volume
            </span>
            <span class="legend-item">
              <span class="legend-swatch" style="background: #f29900"></span>
              Keypress
            </span>
          </div>
        </div>
        <div class="diagnostic-body">
          <div
            class="chart-container"
            id="series-chart-container"
            @pointerdown=${(e: PointerEvent) => this.onTimelinePointerDown(e, 'capture')}
          >
            <canvas class="chart-canvas" id="canvas-series"></canvas>
          </div>
          ${!hasVolume && !hasKeypress
            ? html`<div class="control-hint" style="margin-top: 6px;">
                No applied_input_volume or keypress series recorded in this dump.
              </div>`
            : ''}
        </div>
      </div>
    `;
  }

  private selectMarker(marker: Marker) {
    this.selectedMarker = marker;
    if (this.layout) {
      const evFrame = snapCaptureToEventFrame(this.layout, marker.frame);
      this.seekToEventFrame(evFrame);
    }
  }

  // File selection & drag-drop handling
  private triggerFileSelect() {
    this.shadowRoot?.getElementById('fileInput')?.click();
  }

  private onDragOver(e: DragEvent) {
    e.preventDefault();
    this.shadowRoot?.querySelector('.dropzone')?.classList.add('dragover');
  }

  private onDragLeave() {
    this.shadowRoot?.querySelector('.dropzone')?.classList.remove('dragover');
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    this.onDragLeave();
    const file = e.dataTransfer?.files[0];
    if (file) this.processFile(file);
  }

  private onFileSelected(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) this.processFile(file);
  }

  private async processFile(file: File) {
    this.loading = true;
    this.loadingStatus = `Loading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`;
    this.stopAll();
    this.cleanupTracks();
    this.warnings = [];

    try {
      const arrayBuffer = await file.arrayBuffer();
      this.loadingStatus = 'Parsing AECDump protobuf data...';

      await new Promise((resolve) => setTimeout(resolve, 20));

      const parsed = parseDump(arrayBuffer);
      this.parsedDump = parsed;
      this.warnings = parsed.warnings;

      this.loadingStatus = 'Decoding audio and preparing event-time layout...';
      await new Promise((resolve) => setTimeout(resolve, 20));

      await this.initializeTracks(parsed);
      this.loadingStatus = 'AECDump loaded successfully!';
    } catch (error) {
      console.error(error);
      this.loadingStatus = `Error: ${(error as Error).message}`;
    } finally {
      this.loading = false;
    }
  }

  private recomputeLayoutAndBounds() {
    if (!this.parsedDump) return;
    this.layout = layOutEventTime(this.parsedDump.callOrder, this.allowedLatenessFrames);
    this.driftAnalyses = analyzeDrift(this.parsedDump.callOrder);
    this.renderTransform = makeTransform(this.renderOffsetMs / 1000);

    const layoutSec =
      this.layout.extentFrames > 0
        ? eventFramesToSeconds(this.layout.extentFrames)
        : dumpDuration(this.parsedDump);
    const shiftedSec = layoutSec + this.renderTransform.offsetSeconds;

    this.displayStart = Math.min(0, this.renderTransform.offsetSeconds);
    this.displayEnd = Math.max(layoutSec, shiftedSec, 0.01);
    this.duration = this.displayEnd - this.displayStart;
    this.driftCache = null;
    this.seriesCache = null;
  }

  /** Builds one row per track the dump actually contains. */
  private async initializeTracks(dump: ParsedDump) {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    this.recomputeLayoutAndBounds();
    this.selectedMarker = dump.markers[0] ?? null;
    this.seekResolution = 'exact';

    const buildTrack = (source: DumpTrack): UiTrack | null => {
      if (source.channelData.length === 0 || source.channelData[0].length === 0) return null;
      const audioBuffer = this.audioCtx!.createBuffer(
        source.channels,
        source.channelData[0].length,
        source.sampleRate
      );
      for (let c = 0; c < source.channels; c++) {
        audioBuffer.copyToChannel(new Float32Array(source.channelData[c]), c);
      }
      const blob = new Blob([audioBufferToWav(audioBuffer)], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);

      const uiTrack: UiTrack = {
        id: source.id,
        name: source.name,
        domId: source.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        source,
        peak: peakOf(source),
        gain: 1,
        zoomed: false,
        audioBuffer,
        currentNativeFrame: source.startFrame,
        currentTime: 0,
        playStartNativeFrame: source.startFrame,
        muted: true,
        transport: {
          getCurrentTime: () => uiTrack.currentTime,
          getDuration: () => uiTrack.source.duration,
          getMuted: () => uiTrack.muted,
        },
        waveformCache: null,
        url,
      };
      return uiTrack;
    };

    this.tracks = allTracks(dump).flatMap((source) => {
      const built = buildTrack(source);
      return built ? [built] : [];
    });

    // Default to the microphone input: it is what a user opening a dump is
    // usually looking for, and it exists in every dump that captured anything.
    const preferred =
      this.tracks.find((t) => t.source.kind === 'input') ?? this.tracks[0] ?? null;
    this.audibleTrackId = preferred ? preferred.id : null;
    for (const track of this.tracks) {
      track.muted = track.id !== this.audibleTrackId;
    }

    this.setPositionsForDisplayTime(toDisplayTime(IDENTITY_TRANSFORM, 0), false);

    this.requestUpdate();
    await this.updateComplete;

    this.drawAllCanvases();
  }

  private syncPositionsAfterLayoutChange() {
    if (!this.layout || this.tracks.length === 0) return;
    const audible = this.tracks.find((t) => t.id === this.audibleTrackId) ?? this.tracks[0];
    const streamNative =
      audible.source.timeline === 'render' ? this.renderNativeFrame : this.captureNativeFrame;
    const ev =
      toEventFrame(this.layout, audible.source.timeline, streamNative) ??
      snapCaptureToEventFrame(this.layout, Math.round(streamNative));
    const transform =
      audible.source.timeline === 'render' ? this.renderTransform : IDENTITY_TRANSFORM;
    const displaySec = toDisplayTime(transform, ev);
    this.setPositionsForDisplayTime(displaySec, false);
  }

  private onLatenessInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(val) || val < 0) return;
    this.allowedLatenessFrames = Math.floor(val);
    this.recomputeLayoutAndBounds();
    this.syncPositionsAfterLayoutChange();
    this.drawAllCanvases();
  }

  private onRenderOffsetInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(val)) return;
    this.renderOffsetMs = val;
    this.recomputeLayoutAndBounds();
    this.syncPositionsAfterLayoutChange();
    this.drawAllCanvases();
  }

  private onTimelinePointerDown(e: PointerEvent, _timeline: EventStream) {
    const container = e.currentTarget as HTMLElement;
    if (!container) return;
    container.setPointerCapture?.(e.pointerId);
    this.draggingContainer = container;

    if (this.isPlaying) {
      this.stopWebAudioNodes();
    }

    this.seekAtPointer(e.clientX, container, true);

    const onMove = (moveEvent: PointerEvent) => {
      if (!this.draggingContainer) return;
      this.seekAtPointer(moveEvent.clientX, this.draggingContainer, true);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (this.draggingContainer) {
        this.seekAtPointer(upEvent.clientX, this.draggingContainer, false);
      }
      this.draggingContainer = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  private seekAtPointer(clientX: number, container: HTMLElement, scrubbing = false) {
    if (!this.layout) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const displaySec = this.displayStart + fraction * (this.displayEnd - this.displayStart);
    if (scrubbing) {
      this.setPositionsForDisplayTime(displaySec);
      this.drawAllCanvases();
    } else {
      this.seekToDisplayTime(displaySec);
    }
  }

  private findTrackForKindAtNativeFrame(
    kind: DumpTrack['kind'],
    streamNative: number
  ): UiTrack | null {
    const candidates = this.tracks.filter((t) => t.source.kind === kind);
    if (candidates.length === 0) return null;
    for (const track of candidates) {
      const trackFrames = Math.round(track.source.duration * FRAMES_PER_SECOND);
      const endFrame = track.source.startFrame + trackFrames;
      if (streamNative < endFrame) {
        return track;
      }
    }
    return candidates[candidates.length - 1];
  }

  /**
   * Updates both lanes' stream-wide native positions and every track's local
   * position for a target `displaySec` on `[displayStart, displayEnd]`,
   * without restarting audio playback.
   */
  private setPositionsForDisplayTime(displaySec: number, updateAudibleSegment = true) {
    if (!this.layout) return;

    const clampedDisplaySec = Math.max(
      this.displayStart,
      Math.min(this.displayEnd, displaySec)
    );
    this.cursorDisplaySec = clampedDisplaySec;
    this.currentTime = Math.max(
      0,
      Math.min(this.duration, clampedDisplaySec - this.displayStart)
    );

    const captureEventFrame = displayToEventFrame(IDENTITY_TRANSFORM, clampedDisplaySec);
    const renderEventFrame = displayToEventFrame(this.renderTransform, clampedDisplaySec);

    const captureResult = toNativeFrame(this.layout, 'capture', captureEventFrame);
    const renderResult = toNativeFrame(this.layout, 'render', renderEventFrame);

    this.captureNativeFrame = captureResult.nativeFrame;
    this.renderNativeFrame = renderResult.nativeFrame;

    for (const track of this.tracks) {
      const streamNative =
        track.source.timeline === 'render' ? this.renderNativeFrame : this.captureNativeFrame;
      const trackFrames = Math.round(track.source.duration * FRAMES_PER_SECOND);
      const minNative = track.source.startFrame;
      const maxNative = minNative + trackFrames;
      const clampedNative = Math.max(minNative, Math.min(maxNative, streamNative));

      track.currentNativeFrame = clampedNative;
      track.currentTime = Math.max(
        0,
        Math.min(track.source.duration, (clampedNative - minNative) / FRAMES_PER_SECOND)
      );
    }

    if (updateAudibleSegment && this.audibleTrackId) {
      const currentAudible = this.tracks.find((t) => t.id === this.audibleTrackId);
      if (currentAudible) {
        const streamNative =
          currentAudible.source.timeline === 'render'
            ? this.renderNativeFrame
            : this.captureNativeFrame;
        const matchingTrack = this.findTrackForKindAtNativeFrame(
          currentAudible.source.kind,
          streamNative
        );
        if (matchingTrack && matchingTrack.id !== this.audibleTrackId) {
          this.audibleTrackId = matchingTrack.id;
          for (const track of this.tracks) {
            track.muted = track.id !== this.audibleTrackId;
          }
        }
      }
    }

    const audible = this.tracks.find((t) => t.id === this.audibleTrackId) ?? this.tracks[0];
    if (audible) {
      this.seekResolution =
        audible.source.timeline === 'render'
          ? renderResult.resolution
          : captureResult.resolution;
    }
  }

  private seekToDisplayTime(displaySec: number) {
    if (!this.layout) return;
    this.setPositionsForDisplayTime(displaySec);
    if (this.isPlaying) {
      this.startWebAudioFromCurrentPositions();
    }
    this.drawAllCanvases();
  }

  private seekToEventFrame(eventFrame: number) {
    this.seekToDisplayTime(toDisplayTime(IDENTITY_TRANSFORM, eventFrame));
  }

  private drawAllCanvases() {
    for (const track of this.tracks) {
      this.drawTrackCanvas(track);
    }
    this.drawDriftCanvas();
    this.drawSeriesCanvas();
  }

  private prepareCanvas(canvasId: string, heightCss: number): {
    ctx: CanvasRenderingContext2D;
    width: number;
    height: number;
    dpr: number;
  } | null {
    const canvas = this.shadowRoot?.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return null;
    const parent = canvas.parentElement;
    const width = Math.max(320, parent?.clientWidth || 800);
    const height = heightCss;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, dpr };
  }

  private timeToX(displaySec: number, width: number): number {
    const span = Math.max(0.001, this.displayEnd - this.displayStart);
    return ((displaySec - this.displayStart) / span) * width;
  }

  private ensureTrackWaveformCache(
    track: UiTrack,
    width: number,
    height: number,
    dpr: number
  ): TrackWaveformCache {
    const key = [
      width,
      height,
      dpr,
      this.allowedLatenessFrames,
      this.renderOffsetMs,
      this.displayStart,
      this.displayEnd,
      track.gain,
    ].join(':');
    if (track.waveformCache && track.waveformCache.key === key) {
      return track.waveformCache;
    }

    const createLayer = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      const cctx = c.getContext('2d')!;
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { canvas: c, ctx: cctx };
    };

    const unplayed = createLayer();
    const played = createLayer();
    const midY = height / 2;
    const transform =
      track.source.timeline === 'render' ? this.renderTransform : IDENTITY_TRANSFORM;

    for (const layerCtx of [unplayed.ctx, played.ctx]) {
      // Zero baseline
      layerCtx.strokeStyle = '#eceff1';
      layerCtx.lineWidth = 1;
      layerCtx.beginPath();
      layerCtx.moveTo(0, midY);
      layerCtx.lineTo(width, midY);
      layerCtx.stroke();

      // 1. Draw structural EventTimeGaps on this lane
      for (const gap of this.layout!.gaps) {
        if (gap.stream !== track.source.timeline) continue;
        const x0 = this.timeToX(toDisplayTime(transform, gap.eventStartFrame), width);
        const x1 = this.timeToX(toDisplayTime(transform, gap.eventEndFrame), width);
        const gx = Math.max(0, Math.min(width, x0));
        const gw = Math.max(2, Math.min(width - gx, x1 - x0));

        layerCtx.fillStyle = 'rgba(217, 48, 37, 0.10)';
        layerCtx.fillRect(gx, 0, gw, height);

        // Diagonal hatching
        layerCtx.save();
        layerCtx.beginPath();
        layerCtx.rect(gx, 0, gw, height);
        layerCtx.clip();
        layerCtx.strokeStyle = 'rgba(217, 48, 37, 0.28)';
        layerCtx.lineWidth = 1;
        for (let h = -height; h < gw + height; h += 8) {
          layerCtx.beginPath();
          layerCtx.moveTo(gx + h, 0);
          layerCtx.lineTo(gx + h - height, height);
          layerCtx.stroke();
        }
        layerCtx.restore();

        if (gw >= 36) {
          layerCtx.fillStyle = '#b0251a';
          layerCtx.font = '10px monospace';
          layerCtx.fillText(`gap ${gap.observedLagFrames * FRAME_MS}ms`, gx + 4, 12);
        }
      }
    }

    // 2. Draw waveform runs positioned on the shared display axis
    const trackFrameCount = Math.round(track.source.duration * FRAMES_PER_SECOND);
    const trackStartFrame = track.source.startFrame;
    const trackEndFrame = trackStartFrame + trackFrameCount;
    const samplesPerFrame = Math.max(1, Math.floor(track.source.sampleRate / FRAMES_PER_SECOND));
    const channels = track.source.channelData;
    const totalSamples = channels[0]?.length ?? 0;

    unplayed.ctx.fillStyle = '#8ab4f8';
    played.ctx.fillStyle = '#1a73e8';

    const runs = runsFor(this.layout!, track.source.timeline);
    for (const run of runs) {
      const nativeStart = Math.max(run.nativeStartFrame, trackStartFrame);
      const nativeEnd = Math.min(run.nativeStartFrame + run.frameCount, trackEndFrame);
      if (nativeEnd <= nativeStart) continue;

      const eventStart = run.eventStartFrame + (nativeStart - run.nativeStartFrame);
      const eventEnd = eventStart + (nativeEnd - nativeStart);

      const xStart = this.timeToX(toDisplayTime(transform, eventStart), width);
      const xEnd = this.timeToX(toDisplayTime(transform, eventEnd), width);
      const pxStart = Math.max(0, Math.floor(xStart));
      const pxEnd = Math.min(width - 1, Math.ceil(xEnd));
      if (pxEnd < pxStart) continue;

      const runSampleStart = (nativeStart - trackStartFrame) * samplesPerFrame;
      const runSampleEnd = Math.min(totalSamples, (nativeEnd - trackStartFrame) * samplesPerFrame);
      const runSamples = runSampleEnd - runSampleStart;
      if (runSamples <= 0) continue;

      const pixelSpan = Math.max(1, xEnd - xStart);

      for (let px = pxStart; px <= pxEnd; px++) {
        const rel0 = Math.max(0, Math.min(1, (px - xStart) / pixelSpan));
        const rel1 = Math.max(0, Math.min(1, (px + 1 - xStart) / pixelSpan));
        const s0 = runSampleStart + Math.floor(rel0 * runSamples);
        const s1 = Math.max(s0 + 1, runSampleStart + Math.ceil(rel1 * runSamples));

        let minVal = 0;
        let maxVal = 0;
        for (let c = 0; c < channels.length; c++) {
          const ch = channels[c];
          const limit = Math.min(ch.length, s1);
          for (let s = s0; s < limit; s++) {
            const v = ch[s];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
        }

        const scaledMin = Math.max(-1, Math.min(1, minVal * track.gain));
        const scaledMax = Math.max(-1, Math.min(1, maxVal * track.gain));
        const yTop = midY - scaledMax * (midY - 2);
        const yBot = midY - scaledMin * (midY - 2);
        const barH = Math.max(1.5, yBot - yTop);

        unplayed.ctx.fillRect(px, yTop, 1, barH);
        played.ctx.fillRect(px, yTop, 1, barH);
      }
    }

    const cache: TrackWaveformCache = {
      key,
      unplayedCanvas: unplayed.canvas,
      playedCanvas: played.canvas,
    };
    track.waveformCache = cache;
    return cache;
  }

  private drawTrackCanvas(track: UiTrack) {
    if (!this.layout) return;
    const prepared = this.prepareCanvas(`canvas-${track.domId}`, 80);
    if (!prepared) return;
    const { ctx, width, height, dpr } = prepared;
    const cache = this.ensureTrackWaveformCache(track, width, height, dpr);

    const transform =
      track.source.timeline === 'render' ? this.renderTransform : IDENTITY_TRANSFORM;
    const streamNative =
      track.source.timeline === 'render' ? this.renderNativeFrame : this.captureNativeFrame;
    const trackFrameCount = Math.round(track.source.duration * FRAMES_PER_SECOND);
    const trackStartFrame = track.source.startFrame;
    const trackEndFrame = trackStartFrame + trackFrameCount;

    const cursorEventFrame = toEventFrame(this.layout, track.source.timeline, streamNative);
    const cursorX =
      cursorEventFrame !== null
        ? this.timeToX(toDisplayTime(transform, cursorEventFrame), width)
        : -1;

    if (cursorX <= 0) {
      ctx.drawImage(cache.unplayedCanvas, 0, 0, width, height);
    } else if (cursorX >= width) {
      ctx.drawImage(cache.playedCanvas, 0, 0, width, height);
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cursorX, height);
      ctx.clip();
      ctx.drawImage(cache.playedCanvas, 0, 0, width, height);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(cursorX, 0, width - cursorX, height);
      ctx.clip();
      ctx.drawImage(cache.unplayedCanvas, 0, 0, width, height);
      ctx.restore();
    }

    // 3. Draw synchronized vertical cursor when the stream position is within this track's segment
    if (
      streamNative >= trackStartFrame &&
      streamNative <= trackEndFrame &&
      cursorX >= 0 &&
      cursorX <= width
    ) {
      ctx.strokeStyle = '#202124';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, height);
      ctx.stroke();
    }
  }

  private ensureDriftPlotCache(width: number, height: number, dpr: number): HTMLCanvasElement {
    const key = [
      width,
      height,
      dpr,
      this.allowedLatenessFrames,
      this.renderOffsetMs,
      this.displayStart,
      this.displayEnd,
    ].join(':');
    if (this.driftCache && this.driftCache.key === key) {
      return this.driftCache.canvas;
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(width * dpr);
    offscreen.height = Math.round(height * dpr);
    const bctx = offscreen.getContext('2d')!;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const delaySeries = this.parsedDump!.series.delay;
    const delayPresent = this.parsedDump!.series.delayPresent;
    const driftSeries = this.parsedDump!.series.drift;
    const driftPresent = this.parsedDump!.series.driftPresent;

    let minY = -20;
    let maxY = 60;
    for (const analysis of this.driftAnalyses) {
      for (const p of analysis.points) {
        if (p.driftMs < minY) minY = p.driftMs;
        if (p.driftMs > maxY) maxY = p.driftMs;
      }
    }
    if (delaySeries && delayPresent) {
      for (let i = 0; i < delaySeries.length; i++) {
        if (!delayPresent[i]) continue;
        if (delaySeries[i] < minY) minY = delaySeries[i];
        if (delaySeries[i] > maxY) maxY = delaySeries[i];
      }
    }
    if (driftSeries && driftPresent) {
      for (let i = 0; i < driftSeries.length; i++) {
        if (!driftPresent[i]) continue;
        if (driftSeries[i] < minY) minY = driftSeries[i];
        if (driftSeries[i] > maxY) maxY = driftSeries[i];
      }
    }
    const pad = Math.max(10, (maxY - minY) * 0.1);
    minY -= pad;
    maxY += pad;

    const valToY = (v: number) =>
      height - 10 - ((v - minY) / Math.max(1, maxY - minY)) * (height - 20);

    // Zero line
    const zeroY = valToY(0);
    bctx.strokeStyle = '#dadce0';
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.moveTo(0, zeroY);
    bctx.lineTo(width, zeroY);
    bctx.stroke();

    // Plot cumulative call-order drift (ms), lifting pen across INIT segment boundaries
    if (this.driftAnalyses.some((a) => a.points.length > 0)) {
      bctx.strokeStyle = '#d93025';
      bctx.lineWidth = 1.75;
      bctx.beginPath();
      for (const analysis of this.driftAnalyses) {
        let started = false;
        for (const p of analysis.points) {
          const ev = toEventFrame(this.layout!, 'capture', p.captureFrame);
          if (ev === null) {
            started = false;
            continue;
          }
          const x = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev), width);
          const y = valToY(p.driftMs);
          if (!started) {
            bctx.moveTo(x, y);
            started = true;
          } else {
            bctx.lineTo(x, y);
          }
        }
      }
      bctx.stroke();
    }

    // Plot Stream.delay (ms)
    if (delaySeries && delayPresent) {
      bctx.strokeStyle = '#1a73e8';
      bctx.lineWidth = 1.5;
      bctx.beginPath();
      let penDown = false;
      for (let i = 0; i < delaySeries.length; i++) {
        if (delayPresent[i] !== 1) {
          penDown = false;
          continue;
        }
        const ev = toEventFrame(this.layout!, 'capture', i);
        if (ev === null) {
          penDown = false;
          continue;
        }
        const x = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev), width);
        const y = valToY(delaySeries[i]);
        if (!penDown) {
          bctx.moveTo(x, y);
          penDown = true;
        } else {
          bctx.lineTo(x, y);
        }
      }
      bctx.stroke();
    }

    // Plot Stream.drift (samples) if present
    if (driftSeries && driftPresent) {
      bctx.strokeStyle = '#188038';
      bctx.lineWidth = 1.25;
      bctx.beginPath();
      let penDown = false;
      for (let i = 0; i < driftSeries.length; i++) {
        if (driftPresent[i] !== 1) {
          penDown = false;
          continue;
        }
        const ev = toEventFrame(this.layout!, 'capture', i);
        if (ev === null) {
          penDown = false;
          continue;
        }
        const x = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev), width);
        const y = valToY(driftSeries[i]);
        if (!penDown) {
          bctx.moveTo(x, y);
          penDown = true;
        } else {
          bctx.lineTo(x, y);
        }
      }
      bctx.stroke();
    }

    this.driftCache = { key, canvas: offscreen };
    return offscreen;
  }

  private drawDriftCanvas() {
    if (!this.layout || !this.parsedDump) return;
    const prepared = this.prepareCanvas('canvas-drift', 110);
    if (!prepared) return;
    const { ctx, width, height, dpr } = prepared;

    const bg = this.ensureDriftPlotCache(width, height, dpr);
    ctx.drawImage(bg, 0, 0, width, height);

    // Draw shared cursor
    const cursorX = this.timeToX(this.displayStart + this.currentTime, width);
    if (cursorX >= 0 && cursorX <= width) {
      ctx.strokeStyle = '#202124';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, height);
      ctx.stroke();
    }
  }

  private ensureSeriesPlotCache(width: number, height: number, dpr: number): HTMLCanvasElement {
    const key = [
      width,
      height,
      dpr,
      this.allowedLatenessFrames,
      this.renderOffsetMs,
      this.displayStart,
      this.displayEnd,
    ].join(':');
    if (this.seriesCache && this.seriesCache.key === key) {
      return this.seriesCache.canvas;
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(width * dpr);
    offscreen.height = Math.round(height * dpr);
    const bctx = offscreen.getContext('2d')!;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { appliedInputVolume, appliedInputVolumePresent, keypress, keypressPresent } =
      this.parsedDump!.series;

    if (keypress && keypressPresent) {
      bctx.fillStyle = 'rgba(242, 153, 0, 0.25)';
      for (let i = 0; i < keypress.length; i++) {
        if (keypressPresent[i] === 1 && keypress[i] === 1) {
          const ev0 = toEventFrame(this.layout!, 'capture', i);
          if (ev0 === null) continue;
          const x0 = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev0), width);
          const x1 = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev0 + 1), width);
          bctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
        }
      }
    }

    if (appliedInputVolume && appliedInputVolumePresent) {
      bctx.strokeStyle = '#9334e6';
      bctx.lineWidth = 1.5;
      bctx.beginPath();
      let penDown = false;
      for (let i = 0; i < appliedInputVolume.length; i++) {
        if (appliedInputVolumePresent[i] !== 1) {
          penDown = false;
          continue;
        }
        const ev = toEventFrame(this.layout!, 'capture', i);
        if (ev === null) {
          penDown = false;
          continue;
        }
        const x = this.timeToX(toDisplayTime(IDENTITY_TRANSFORM, ev), width);
        const norm = Math.max(0, Math.min(1, appliedInputVolume[i] / 255));
        const y = height - 8 - norm * (height - 16);
        if (!penDown) {
          bctx.moveTo(x, y);
          penDown = true;
        } else {
          bctx.lineTo(x, y);
        }
      }
      bctx.stroke();
    }

    this.seriesCache = { key, canvas: offscreen };
    return offscreen;
  }

  private drawSeriesCanvas() {
    if (!this.layout || !this.parsedDump) return;
    const prepared = this.prepareCanvas('canvas-series', 80);
    if (!prepared) return;
    const { ctx, width, height, dpr } = prepared;

    const bg = this.ensureSeriesPlotCache(width, height, dpr);
    ctx.drawImage(bg, 0, 0, width, height);

    const cursorX = this.timeToX(this.displayStart + this.currentTime, width);
    if (cursorX >= 0 && cursorX <= width) {
      ctx.strokeStyle = '#202124';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, height);
      ctx.stroke();
    }
  }

  // WebAudio playback engine
  private stopWebAudioNodes() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.activeSourceNode) {
      const node = this.activeSourceNode;
      this.activeSourceNode = null;
      try {
        node.onended = null;
        node.stop();
      } catch {
        // Ignore if already stopped
      }
      node.disconnect();
    }
    if (this.activeGainNode) {
      this.activeGainNode.disconnect();
      this.activeGainNode = null;
    }
  }

  private startWebAudioFromCurrentPositions() {
    this.stopWebAudioNodes();
    if (!this.audioCtx || this.tracks.length === 0) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    let audible =
      this.tracks.find((t) => t.id === this.audibleTrackId) ?? this.tracks[0];
    if (!audible) return;

    // If the audible track is at its end, either advance to the next segment of
    // the same kind or rewind to the start of the dump without re-entering
    // startWebAudioFromCurrentPositions().
    if (audible.currentTime >= audible.source.duration - 0.005) {
      const nextTrack = this.tracks.find(
        (t) =>
          t.source.kind === audible.source.kind &&
          t.source.initIndex > audible.source.initIndex &&
          t.currentTime < t.source.duration - 0.005
      );
      if (nextTrack) {
        this.audibleTrackId = nextTrack.id;
        for (const track of this.tracks) {
          track.muted = track.id !== this.audibleTrackId;
        }
        audible = nextTrack;
      } else {
        this.setPositionsForDisplayTime(this.displayStart);
        audible =
          this.tracks.find((t) => t.id === this.audibleTrackId) ?? this.tracks[0];
        if (!audible) return;
      }
    }

    for (const track of this.tracks) {
      track.playStartNativeFrame = track.currentNativeFrame;
    }
    this.playStartCtxTime = this.audioCtx.currentTime;

    const sourceNode = this.audioCtx.createBufferSource();
    sourceNode.buffer = audible.audioBuffer;
    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = 1.0;
    sourceNode.connect(gainNode);
    gainNode.connect(this.audioCtx.destination);

    const startOffset = Math.max(
      0,
      Math.min(audible.source.duration, audible.currentTime)
    );
    let sourceEnded = false;
    sourceNode.onended = () => {
      if (this.activeSourceNode === sourceNode && this.isPlaying) {
        sourceEnded = true;
        tick();
      }
    };
    sourceNode.start(0, startOffset);

    this.activeSourceNode = sourceNode;
    this.activeGainNode = gainNode;

    const tick = () => {
      if (!this.isPlaying || !this.audioCtx || !this.layout) return;
      const currentAudible =
        this.tracks.find((t) => t.id === this.audibleTrackId) ?? this.tracks[0];
      if (!currentAudible) return;

      const elapsedSec = Math.max(0, this.audioCtx.currentTime - this.playStartCtxTime);
      const elapsedFrames = elapsedSec * FRAMES_PER_SECOND;
      const audibleFrames = Math.round(currentAudible.source.duration * FRAMES_PER_SECOND);
      const maxAudibleNative = currentAudible.source.startFrame + audibleFrames;
      const nextAudibleNative = sourceEnded
        ? maxAudibleNative
        : Math.min(maxAudibleNative, currentAudible.playStartNativeFrame + elapsedFrames);

      const evFrame = toEventFrame(
        this.layout,
        currentAudible.source.timeline,
        nextAudibleNative
      );
      if (evFrame !== null) {
        const transform =
          currentAudible.source.timeline === 'render'
            ? this.renderTransform
            : IDENTITY_TRANSFORM;
        const displaySec = toDisplayTime(transform, evFrame);
        this.setPositionsForDisplayTime(displaySec, false);
      } else {
        if (currentAudible.source.timeline === 'render') {
          this.renderNativeFrame = nextAudibleNative;
        } else {
          this.captureNativeFrame = nextAudibleNative;
        }
        for (const track of this.tracks) {
          const streamNative =
            track.source.timeline === 'render' ? this.renderNativeFrame : this.captureNativeFrame;
          const trackFrames = Math.round(track.source.duration * FRAMES_PER_SECOND);
          const minNative = track.source.startFrame;
          const maxNative = minNative + trackFrames;
          const clampedNative = Math.max(minNative, Math.min(maxNative, streamNative));
          track.currentNativeFrame = clampedNative;
          track.currentTime = Math.max(
            0,
            Math.min(track.source.duration, (clampedNative - minNative) / FRAMES_PER_SECOND)
          );
        }
      }

      if (nextAudibleNative >= maxAudibleNative) {
        const nextTrack = this.tracks.find(
          (t) =>
            t.source.kind === currentAudible.source.kind &&
            t.source.initIndex > currentAudible.source.initIndex
        );
        if (nextTrack) {
          this.audibleTrackId = nextTrack.id;
          for (const track of this.tracks) {
            track.muted = track.id !== nextTrack.id;
          }
          const nextEv = toEventFrame(
            this.layout,
            nextTrack.source.timeline,
            nextTrack.source.startFrame
          );
          if (nextEv !== null) {
            const transform =
              nextTrack.source.timeline === 'render'
                ? this.renderTransform
                : IDENTITY_TRANSFORM;
            this.setPositionsForDisplayTime(toDisplayTime(transform, nextEv), false);
          }
          nextTrack.currentNativeFrame = nextTrack.source.startFrame;
          nextTrack.currentTime = 0;
          this.requestUpdate();
          this.drawAllCanvases();
          this.startWebAudioFromCurrentPositions();
          return;
        }
        this.isPlaying = false;
        this.stopWebAudioNodes();
        this.drawAllCanvases();
        return;
      }

      this.drawAllCanvases();
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private togglePlay() {
    if (this.tracks.length === 0) return;

    if (this.isPlaying) {
      this.isPlaying = false;
      this.stopWebAudioNodes();
      return;
    }

    this.isPlaying = true;
    this.startWebAudioFromCurrentPositions();
  }

  private stopAll() {
    this.isPlaying = false;
    this.stopWebAudioNodes();
    if (this.layout && this.tracks.length > 0) {
      this.seekToDisplayTime(this.displayStart);
    } else {
      this.currentTime = 0;
    }
  }

  /**
   * Toggles a track between absolute scale (gain = 1) and filling its lane (gain = 1 / peak).
   */
  private toggleGain(id: string) {
    this.tracks = this.tracks.map((track) => {
      if (track.id !== id) return track;
      const nextZoomed = !track.zoomed && track.peak > 0;
      const gain = nextZoomed ? 1 / track.peak : 1;
      return { ...track, zoomed: nextZoomed, gain, waveformCache: null };
    });
    this.requestUpdate();
    this.updateComplete.then(() => this.drawAllCanvases());
  }

  /** Moves audio output to one track, leaving every cursor where it is. */
  private setAudibleTrack(id: string) {
    this.audibleTrackId = id;
    for (const track of this.tracks) {
      track.muted = track.id !== id;
    }
    if (this.isPlaying) {
      this.startWebAudioFromCurrentPositions();
    }
    this.requestUpdate();
  }

  private cleanupTracks() {
    this.stopWebAudioNodes();
    for (const track of this.tracks) {
      if (track.url) {
        URL.revokeObjectURL(track.url);
        track.url = null;
      }
      track.waveformCache = null;
    }
    this.tracks = [];
    this.driftCache = null;
    this.seriesCache = null;
    this.isPlaying = false;
    this.duration = 0;
    this.currentTime = 0;
    this.cursorDisplaySec = 0;
    this.captureNativeFrame = 0;
    this.renderNativeFrame = 0;
  }

  private formatTime(seconds: number): string {
    const safe = Math.max(0, seconds);
    const min = Math.floor(safe / 60);
    const sec = Math.floor(safe % 60);
    const ms = Math.floor((safe % 1) * 100);
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.tracks.length > 0) {
          this.drawAllCanvases();
        }
      });
      this.resizeObserver.observe(this);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.cleanupTracks();
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}
