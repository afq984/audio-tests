import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import WaveSurfer from 'wavesurfer.js';
import { parseDump } from './parse-dump.js';
import { DumpTrack, ParsedDump, allTracks } from './dump-model.js';
import { audioBufferToWav } from './wav-helper.js';

/**
 * One row in the viewer.
 *
 * Tracks come from the dump rather than a fixed set: a dump has as many as its
 * INIT events produced, they are named the way `unpack_aecdump` names its
 * files, and a stream that never carried data has no row at all.
 */
interface UiTrack {
  /** Stable identity from the parser: `init1:reverse`. Not the display name,
   *  which can collide when two INITs are separated by no capture frames. */
  id: string;
  /** unpack-style name, e.g. `reverse1200.wav`. */
  name: string;
  /** Safe for an element id and a CSS selector; `id` contains a colon. */
  domId: string;
  source: DumpTrack;
  /** Largest absolute sample across every channel, in [0, 1]. */
  peak: number;
  ws: WaveSurfer | null;
  url: string | null;
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
  /**
   * The one track connected to audio output.
   *
   * Playing every track at once is a DAW feature with no use here -- the
   * streams are different points in one signal chain, not parts of a mix, and
   * hearing them summed tells you nothing. Seeking still moves every track.
   */
  @state() private audibleTrackId: string | null = null;

  private audioCtx: AudioContext | null = null;
  private syncSeeking = false;

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
      margin-bottom: 30px;
      border-bottom: 1px solid #eee;
      padding-bottom: 20px;
    }

    h1 {
      margin: 0 0 10px 0;
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
      padding: 40px 20px;
      text-align: center;
      background: #fafafa;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
      margin-bottom: 20px;
    }

    .dropzone:hover, .dropzone.dragover {
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
      align-items: center;
      gap: 15px;
      margin-bottom: 25px;
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
    }

    button {
      background: #1a73e8;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
      font-size: 14px;
    }

    button:hover {
      background: #1557b0;
    }

    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    button.secondary {
      background: #f1f3f4;
      color: #3c4043;
      border: 1px solid #dadce0;
    }

    button.secondary:hover {
      background: #e8eaed;
    }

    button.active {
      background: #d93025;
    }

    button.active:hover {
      background: #b0251a;
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
      gap: 20px;
    }

    .track-card {
      border: 1px solid #dadce0;
      border-radius: 8px;
      background: white;
      overflow: hidden;
      box-shadow: 0 1px 2px 0 rgba(60,64,67,0.3), 0 1px 3px 1px rgba(60,64,67,0.15);
    }

    .track-header {
      background: #f8f9fa;
      padding: 10px 15px;
      border-bottom: 1px solid #dadce0;
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .track-title {
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

    .track-controls button {
      padding: 4px 8px;
      font-size: 12px;
    }

    .track-controls button.listen.active {
      background: #1a73e8;
      color: white;
      border-color: #1a73e8;
    }

    .track-meta {
      font-family: monospace;
      font-size: 12px;
      color: #5f6368;
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

    .track-body {
      padding: 15px;
      background: #fafafa;
      position: relative;
    }

    .waveform-container {
      background: white;
      border: 1px solid #eee;
      border-radius: 4px;
      min-height: 80px;
    }
  `;

  override render() {
    const hasTracks = this.tracks.length > 0;

    return html`
      <header>
        <h1>AECDump Web Viewer</h1>
        <p class="description">In-browser replacement for unpack_aecdump: decodes a dump to its streams, names them the way unpack does, and plays them.</p>
      </header>

      <div 
        class="dropzone" 
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
        @click=${this.triggerFileSelect}
      >
        <p>${this.loading ? 'Parsing dump...' : 'Drag & drop an aecdump/protobuf file here, or click to select'}</p>
        <input type="file" id="fileInput" accept=".pb,.aecdump,.aecdump.binpb,.binpb,*" @change=${this.onFileSelected}>
      </div>

      ${this.loadingStatus ? html`<div class="status">${this.loadingStatus}</div>` : ''}

      ${this.warnings.length > 0 ? html`
        <ul class="warnings" id="warnings">
          ${this.warnings.map(w => html`<li>${w}</li>`)}
        </ul>
      ` : ''}

      ${hasTracks ? html`
        <div class="controls">
          <button @click=${this.togglePlay}>${this.isPlaying ? 'Pause' : 'Play'}</button>
          <button class="secondary" @click=${this.stopAll}>Stop</button>
          
          <div class="time-display">
            ${this.formatTime(this.currentTime)} / ${this.formatTime(this.duration)}
          </div>
        </div>

        <div class="tracks-container">
          ${this.tracks.map(track => this.renderTrackCard(track))}
        </div>
      ` : ''}
    `;
  }

  private renderTrackCard(track: UiTrack) {
    const audible = track.id === this.audibleTrackId;
    return html`
      <div class="track-card">
        <div class="track-header">
          <span class="track-title">${track.name}</span>

          <div class="track-controls">
            <span class="track-meta">
              ${track.source.sampleRate} Hz
              ${track.source.channels > 1 ? html`&times;${track.source.channels}` : ''}
              &middot; ${track.source.duration.toFixed(2)}s
              &middot; ${track.source.timeline}
              &middot; peak ${formatDbfs(track.peak)}
            </span>
            <button
              class="secondary listen ${audible ? 'active' : ''}"
              id="listen-${track.domId}"
              @click=${() => this.setAudibleTrack(track.id)}
            >
              ${audible ? 'Listening' : 'Listen'}
            </button>
          </div>
        </div>
        <div class="track-body">
          <div class="waveform-container" id="waveform-${track.domId}"></div>
        </div>
      </div>
    `;
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
    this.destroyWaveSurfers();
    this.warnings = [];

    try {
      const arrayBuffer = await file.arrayBuffer();
      this.loadingStatus = 'Parsing AECDump protobuf data...';
      
      // Small delay to allow UI to update
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const parsed = parseDump(arrayBuffer);
      this.warnings = parsed.warnings;
      
      this.loadingStatus = 'Decoding audio and preparing tracks...';
      await new Promise(resolve => setTimeout(resolve, 50));

      await this.initializeTracks(parsed);
      this.loadingStatus = 'AECDump loaded successfully!';
    } catch (error) {
      console.error(error);
      this.loadingStatus = `Error: ${(error as Error).message}`;
    } finally {
      this.loading = false;
    }
  }

  /** Builds one row per track the dump actually contains. */
  private async initializeTracks(dump: ParsedDump) {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const wavUrl = (track: DumpTrack): string | null => {
      if (track.channelData.length === 0 || track.channelData[0].length === 0) return null;
      const buffer = this.audioCtx!.createBuffer(
        track.channels,
        track.channelData[0].length,
        track.sampleRate
      );
      for (let c = 0; c < track.channels; c++) {
        buffer.copyToChannel(track.channelData[c] as any, c);
      }
      const blob = new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    };

    this.tracks = allTracks(dump).flatMap((source) => {
      const url = wavUrl(source);
      if (!url) return [];
      return [
        {
          id: source.id,
          name: source.name,
          // The parser's id carries a colon, which is not usable unescaped in
          // a CSS selector.
          domId: source.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
          source,
          peak: peakOf(source),
          ws: null,
          url,
        },
      ];
    });

    // Default to the microphone input: it is what a user opening a dump is
    // usually looking for, and it exists in every dump that captured anything.
    const preferred =
      this.tracks.find((t) => t.source.kind === 'input') ?? this.tracks[0] ?? null;
    this.audibleTrackId = preferred ? preferred.id : null;

    this.requestUpdate();
    await this.updateComplete;

    this.initWaveSurfers();
  }

  private initWaveSurfers() {
    const wsOptions = {
      height: 80,
      waveColor: '#a8c7fa',
      progressColor: '#1a73e8',
      cursorColor: '#3c4043',
      cursorWidth: 2,
      dragToSeek: true,
      // Not normalized. Each track would otherwise be scaled to its own peak,
      // so a capture stream 25dB below the playout reference draws exactly as
      // tall as it does -- and a user who presses play and hears almost
      // nothing has no way to tell a quiet dump from a broken decode. Levels
      // across tracks are one of the things this view is for.
      normalize: false,
    };

    for (const track of this.tracks) {
      const container = this.shadowRoot?.getElementById(`waveform-${track.domId}`);
      if (!container || !track.url) continue;

      const ws = WaveSurfer.create({ ...wsOptions, container, url: track.url });
      track.ws = ws;
      ws.setMuted(track.id !== this.audibleTrackId);

      // The longest track drives the transport clock. Every track is on its own
      // native clock and they need not be the same length, so taking the first
      // one would stop the display short of a longer stream.
      ws.on('ready', (duration) => {
        this.duration = Math.max(this.duration, duration);
      });
      // Bound for every track, not just the audible one: output moves between
      // tracks and a handler attached only at load would leave the clock frozen
      // and the Play button stuck after a switch.
      ws.on('timeupdate', (time) => {
        if (track.id === this.audibleTrackId) this.currentTime = time;
      });
      ws.on('finish', () => {
        if (track.id === this.audibleTrackId) this.isPlaying = false;
      });

      // Synchronized Seeking
      // Use the time carried by the event rather than ws.getCurrentTime():
      // on the drag path wavesurfer emits 'interaction' immediately but
      // debounces the actual seek, so getCurrentTime() is still the old
      // position and the other tracks would sync to a stale point.
      ws.on('interaction', (newTime) => {
        if (this.syncSeeking) return;
        this.syncSeeking = true;
        for (const other of this.tracks) {
          if (other.id !== track.id && other.ws) other.ws.setTime(newTime);
        }
        this.syncSeeking = false;
      });
    }
  }

  private destroyWaveSurfers() {
    for (const track of this.tracks) {
      if (track.ws) {
        track.ws.destroy();
        track.ws = null;
      }
      if (track.url) {
        URL.revokeObjectURL(track.url);
        track.url = null;
      }
    }
    this.tracks = [];
    this.isPlaying = false;
    this.duration = 0;
    this.currentTime = 0;
  }

  // Master controls
  private togglePlay() {
    if (this.tracks.length === 0) return;

    if (this.isPlaying) {
      for (const track of this.tracks) track.ws?.pause();
      this.isPlaying = false;
      return;
    }
    // Every track advances so the cursors stay together, but only the audible
    // one is unmuted -- summing points in one signal chain is not a mix.
    for (const track of this.tracks) track.ws?.play();
    this.isPlaying = true;
  }

  private stopAll() {
    for (const track of this.tracks) track.ws?.stop();
    this.isPlaying = false;
    this.currentTime = 0;
  }

  /** Moves audio output to one track, leaving every cursor where it is. */
  private setAudibleTrack(id: string) {
    this.audibleTrackId = id;
    for (const track of this.tracks) {
      track.ws?.setMuted(track.id !== id);
    }
  }

  private formatTime(seconds: number): string {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyWaveSurfers();
  }
}
