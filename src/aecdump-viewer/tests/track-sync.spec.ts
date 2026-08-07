import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'synthetic-2s.aecdump.binpb');

/** Reads every track's wavesurfer clock straight off the component. */
async function currentTimes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.querySelector('aecdump-viewer') as any;
    return {
      times: el.tracks.map((t: any) => t.ws.getCurrentTime()) as number[],
      names: el.tracks.map((t: any) => t.name) as string[],
      duration: Math.max(...el.tracks.map((t: any) => t.ws.getDuration() as number)),
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
          el.tracks.every((t: any) => t.ws?.getDuration() > 0)
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
      return el.tracks.map((t: any) => t.ws.getMuted() as boolean);
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
      return el.tracks.map((t: any) => t.ws.getMuted() as boolean);
    });
    expect(muted).toEqual([false, true, true]);
    expect((await currentTimes(page)).times).toEqual(before);
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
          el.tracks.every((t: any) => t.ws?.getDuration() > 0)
        );
      },
      undefined,
      { timeout: 20000 }
    );
  });

  test('dragging a waveform moves every track to the dragged position', async ({ page }) => {
    // wavesurfer emits 'interaction' as soon as the drag starts but debounces
    // the actual seek by 200ms while paused, so a handler that reads
    // getCurrentTime() sees the pre-drag position and leaves the other tracks
    // behind. The event argument carries the correct target time.
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

    // Wait past the drag-to-seek debounce so the dragged track has settled too.
    await page.waitForTimeout(600);
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
    await page.waitForTimeout(300);

    const { times, names, duration } = await currentTimes(page);
    const target = duration * targetFraction;
    const tolerance = duration * 0.05;
    times.forEach((time, i) => {
      expect(Math.abs(time - target), `${names[i]} should be at the clicked position`).toBeLessThan(
        tolerance
      );
    });
  });
});
