import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'synthetic-2s.aecdump.binpb');

/**
 * Builds a 2-segment same-format dump by taking the first INIT + N capture/render
 * frame pairs from the committed fixture and concatenating two segments back-to-back.
 */
function makeTwoSegmentBuffer(framesPerSegment = 25): Buffer {
  const raw = readFileSync(FIXTURE);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const recordsNeeded = 1 + framesPerSegment * 2;
  let offset = 0;
  for (let i = 0; i < recordsNeeded && offset < raw.byteLength; i++) {
    const size = view.getInt32(offset, true);
    offset += 4 + size;
  }
  const oneSegment = raw.subarray(0, offset);
  return Buffer.concat([oneSegment, oneSegment]);
}

/** Reads every track's transport clock straight off the component. */
async function currentTimes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.querySelector('aecdump-viewer') as any;
    return {
      times: el.tracks.map((t: any) => t.transport.getCurrentTime()) as number[],
      names: el.tracks.map((t: any) => t.name) as string[],
      duration: Math.max(...el.tracks.map((t: any) => t.transport.getDuration() as number)),
    };
  });
}

test.describe('the dump decides the tracks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('#fileInput').setInputFiles(FIXTURE);
    // Every track must have decoded before its clock means anything.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        return (
          el?.tracks?.length > 0 &&
          el.tracks.every((t: any) => t.transport?.getDuration() > 0)
        );
      },
      undefined,
      { timeout: 20000 }
    );
  });

  test('names tracks the way unpack_aecdump names its files', async ({ page }) => {
    const { names } = await currentTimes(page);
    // Not a fixed Reference/Microphone/Output triple: the names come from the
    // dump, so they carry the capture frame the segment started at.
    expect(names).toEqual(['reverse0.wav', 'input0.wav', 'ref_out0.wav']);
  });

  test('connects exactly one track to audio output', async ({ page }) => {
    const muted = await page.evaluate(() => {
      const el = document.querySelector('aecdump-viewer') as any;
      return el.tracks.map((t: any) => t.transport.getMuted() as boolean);
    });
    expect(muted.filter((m: boolean) => !m)).toHaveLength(1);
    // Defaults to the microphone input, which is what a dump is usually opened
    // to hear.
    expect(muted).toEqual([true, false, true]);
  });

  test('moves audio output without moving the cursors', async ({ page }) => {
    const before = (await currentTimes(page)).times;
    await page.locator('#listen-init1-reverse').click();
    const muted = await page.evaluate(() => {
      const el = document.querySelector('aecdump-viewer') as any;
      return el.tracks.map((t: any) => t.transport.getMuted() as boolean);
    });
    expect(muted).toEqual([false, true, true]);
    expect((await currentTimes(page)).times).toEqual(before);
  });

  test('renders event-time layout, diagnostic lanes, and controls without errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: Error[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err));

    await expect(page.locator('#lateness-input')).toBeVisible();
    await expect(page.locator('#render-offset-input')).toBeVisible();
    await expect(page.locator('#seek-resolution')).toBeVisible();
    await expect(page.locator('#markers-lane')).toBeVisible();
    await expect(page.locator('#drift-lane')).toBeVisible();
    await expect(page.locator('#series-lane')).toBeVisible();

    // Verify marker detail panel shows INIT details
    await expect(page.locator('#marker-detail-panel')).toContainText('Init #1');

    // Verify toggleGain toggles between Fit and zoomed multiplier
    const zoomBtn = page.locator('#zoom-init1-input');
    await expect(zoomBtn).toHaveText('Fit');
    await zoomBtn.click();
    await expect(zoomBtn).not.toHaveText('Fit');
    await zoomBtn.click();
    await expect(zoomBtn).toHaveText('Fit');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('synchronized seeking', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('#fileInput').setInputFiles(FIXTURE);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        return (
          el?.tracks?.length > 0 &&
          el.tracks.every((t: any) => t.transport?.getDuration() > 0)
        );
      },
      undefined,
      { timeout: 20000 }
    );
  });

  test('dragging a waveform moves every track to the dragged position', async ({ page }) => {
    const box = await page.locator('#waveform-init1-reverse').boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const targetFraction = 0.7;
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * targetFraction, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    const { times, names, duration } = await currentTimes(page);

    const target = duration * targetFraction;
    const tolerance = duration * 0.05;
    times.forEach((time, i) => {
      expect(Math.abs(time - target), `${names[i]} should be at the dragged position`).toBeLessThan(
        tolerance
      );
    });
  });

  test('clicking a waveform moves every track to the clicked position', async ({ page }) => {
    const box = await page.locator('#waveform-init1-input').boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const targetFraction = 0.4;
    await page.mouse.click(box.x + box.width * targetFraction, box.y + box.height / 2);

    const { times, names, duration } = await currentTimes(page);
    const target = duration * targetFraction;
    const tolerance = duration * 0.05;
    times.forEach((time, i) => {
      expect(Math.abs(time - target), `${names[i]} should be at the clicked position`).toBeLessThan(
        tolerance
      );
    });
  });

  test('with a non-zero render offset, clicking either lane aligns cursors and changing offset updates currentTime immediately', async ({
    page,
  }) => {
    await page.locator('#render-offset-input').fill('200');
    await page.locator('#render-offset-input').dispatchEvent('input');

    // Click on capture waveform at 50% of display span ([0, 2.2s] -> 1.1s)
    const capBox = await page.locator('#waveform-init1-input').boundingBox();
    expect(capBox).not.toBeNull();
    if (!capBox) return;
    await page.mouse.click(capBox.x + capBox.width * 0.5, capBox.y + capBox.height / 2);

    const readCursorDisplaySeconds = () =>
      page.evaluate(() => {
        const el = document.querySelector('aecdump-viewer') as any;
        const tracks: Array<{ name: string; displaySec: number; trackTime: number }> =
          el.tracks.map((t: any) => {
            const tl = t.source.timeline;
            const runs = tl === 'render' ? el.layout.renderRuns : el.layout.captureRuns;
            const n = t.currentNativeFrame;
            const run = runs.find(
              (r: any) => n >= r.nativeStartFrame && n <= r.nativeStartFrame + r.frameCount
            );
            const ev = run ? run.eventStartFrame + (n - run.nativeStartFrame) : NaN;
            const off = tl === 'render' ? el.renderTransform.offsetSeconds : 0;
            return {
              name: t.name as string,
              displaySec: ev * 0.01 + off,
              trackTime: t.transport.getCurrentTime() as number,
            };
          });
        return { tracks, currentTime: el.currentTime as number };
      });

    const afterCapClick = await readCursorDisplaySeconds();
    const capSec1 = afterCapClick.tracks.find((x) => x.name.startsWith('input'))!.displaySec;
    const revSec1 = afterCapClick.tracks.find((x) => x.name.startsWith('reverse'))!.displaySec;
    expect(Math.abs(revSec1 - capSec1)).toBeLessThan(0.02);
    expect(Math.abs(capSec1 - 1.1)).toBeLessThan(0.02);

    // Click on render waveform at 60% of display span ([0, 2.2s] -> 1.32s)
    const revBox = await page.locator('#waveform-init1-reverse').boundingBox();
    expect(revBox).not.toBeNull();
    if (!revBox) return;
    await page.mouse.click(revBox.x + revBox.width * 0.6, revBox.y + revBox.height / 2);

    const afterRevClick = await readCursorDisplaySeconds();
    const capSec2 = afterRevClick.tracks.find((x) => x.name.startsWith('input'))!.displaySec;
    const revSec2 = afterRevClick.tracks.find((x) => x.name.startsWith('reverse'))!.displaySec;
    expect(Math.abs(revSec2 - capSec2)).toBeLessThan(0.02);
    expect(Math.abs(capSec2 - 1.32)).toBeLessThan(0.02);

    // Changing #render-offset-input to -200 shifts displayStart to -0.2s and immediately
    // updates both el.currentTime and the render track's currentTime without another seek.
    const beforeOffsetChange = afterRevClick.currentTime;
    const revTimeBefore = afterRevClick.tracks.find((x) => x.name.startsWith('reverse'))!.trackTime;
    await page.locator('#render-offset-input').fill('-200');
    await page.locator('#render-offset-input').dispatchEvent('input');

    const afterOffsetChange = await readCursorDisplaySeconds();
    expect(afterOffsetChange.currentTime).toBeCloseTo(beforeOffsetChange + 0.2, 2);
    const revTimeAfter = afterOffsetChange.tracks.find((x) => x.name.startsWith('reverse'))!.trackTime;
    expect(revTimeAfter).toBeCloseTo(revTimeBefore + 0.4, 2);
  });
});

test.describe('playback lifecycle and multi-INIT continuation', () => {
  test('pressing Play at the end of a track starts exactly 1 source and Pause leaves 0 live sources', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as any;
      w.__live = 0;
      w.__started = 0;
      const proto = AudioBufferSourceNode.prototype as any;
      const origStart = proto.start;
      const origStop = proto.stop;
      proto.start = function (...args: any[]) {
        w.__live++;
        w.__started++;
        this.__live = true;
        this.addEventListener('ended', () => {
          if (this.__live) {
            this.__live = false;
            w.__live--;
          }
        });
        return origStart.apply(this, args);
      };
      proto.stop = function (...args: any[]) {
        if (this.__live) {
          this.__live = false;
          w.__live--;
        }
        return origStop.apply(this, args);
      };
    });

    await page.goto('/');
    await page.locator('#fileInput').setInputFiles(FIXTURE);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        return (
          el?.tracks?.length > 0 &&
          el.tracks.every((t: any) => t.transport?.getDuration() > 0)
        );
      },
      undefined,
      { timeout: 20000 }
    );

    await page.evaluate(() => {
      const el = document.querySelector('aecdump-viewer') as any;
      el.seekToEventFrame(el.layout.extentFrames);
    });

    await page.locator('#play-pause-btn').click();
    await page.waitForTimeout(200);

    const afterPlay = await page.evaluate(() => ({
      live: (window as any).__live,
      started: (window as any).__started,
    }));
    expect(afterPlay.live, 'only one source should be playing').toBe(1);
    expect(afterPlay.started, 'should not start duplicate sources on rewind').toBe(1);

    await page.locator('#play-pause-btn').click();
    await page.waitForTimeout(100);

    const afterPause = await page.evaluate(() => ({
      live: (window as any).__live,
    }));
    expect(afterPause.live, 'pause should silence everything').toBe(0);
  });

  test('playback holds segment 2 at 0 while segment 1 plays and continues across INIT into segment 2', async ({
    page,
  }) => {
    await page.goto('/');
    const twoSegBuffer = makeTwoSegmentBuffer(25); // 250ms per segment
    await page.locator('#fileInput').setInputFiles({
      name: 'two-segment.aecdump.binpb',
      mimeType: 'application/octet-stream',
      buffer: twoSegBuffer,
    });

    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        return (
          el?.tracks?.length === 6 &&
          el.tracks.every((t: any) => t.transport?.getDuration() > 0)
        );
      },
      undefined,
      { timeout: 20000 }
    );

    // Start playback from the beginning of segment 1
    await page.locator('#play-pause-btn').click();

    // Wait until segment 1 has advanced slightly, and verify segment 2's track is still at 0
    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        const seg1 = el.tracks.find((t: any) => t.id === 'init1:input');
        return seg1 && seg1.transport.getCurrentTime() > 0.03 && el.audibleTrackId === 'init1:input';
      },
      undefined,
      { timeout: 5000 }
    );

    const duringSeg1 = await page.evaluate(() => {
      const el = document.querySelector('aecdump-viewer') as any;
      const seg1 = el.tracks.find((t: any) => t.id === 'init1:input');
      const seg2 = el.tracks.find((t: any) => t.id === 'init2:input');
      return {
        audibleTrackId: el.audibleTrackId,
        seg1Time: seg1.transport.getCurrentTime(),
        seg2Time: seg2.transport.getCurrentTime(),
      };
    });
    expect(duringSeg1.audibleTrackId).toBe('init1:input');
    expect(duringSeg1.seg1Time).toBeGreaterThan(0);
    expect(duringSeg1.seg2Time).toBe(0);

    // Wait for playback to cross the INIT boundary into segment 2 and advance segment 2
    await page.waitForFunction(
      () => {
        const el = document.querySelector('aecdump-viewer') as any;
        const seg2 = el.tracks.find((t: any) => t.id === 'init2:input');
        return el.audibleTrackId === 'init2:input' && seg2 && seg2.transport.getCurrentTime() > 0.02;
      },
      undefined,
      { timeout: 5000 }
    );

    const duringSeg2 = await page.evaluate(() => {
      const el = document.querySelector('aecdump-viewer') as any;
      const seg1 = el.tracks.find((t: any) => t.id === 'init1:input');
      const seg2 = el.tracks.find((t: any) => t.id === 'init2:input');
      return {
        audibleTrackId: el.audibleTrackId,
        seg1Time: seg1.transport.getCurrentTime(),
        seg2Time: seg2.transport.getCurrentTime(),
      };
    });
    expect(duringSeg2.audibleTrackId).toBe('init2:input');
    expect(duringSeg2.seg1Time).toBeCloseTo(0.25, 2);
    expect(duringSeg2.seg2Time).toBeGreaterThan(0.02);
  });
});
