// 2.3 — content/picker.ts pick-mode hover highlight.
//
// Gate from tasks.md:
//   enter pick mode → hover an element → outline visible; exit pick mode →
//   no outline left in DOM.
//
// We drive the Picker class directly through the testbed (no panel wiring
// in this slice). Hover is simulated via page.mouse.move so the picker's
// mousemove listener fires; the overlay's bounding rect is sampled from
// `getComputedStyle` to confirm it tracked the target. Exit removes the
// overlay node entirely — assert by counting elements with the picker's id.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(
  resolve(__dirname, '..', 'fixtures', 'rolecast.html'),
).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('2.3 — Picker', () => {
  test('hover paints an outline overlay; stop() removes it from the DOM', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    // Pre-condition: no overlay element exists on a fresh page.
    expect(await page.locator('#nf-pick-outline').count()).toBe(0);

    // Start the picker.
    await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const picker = new nf.Picker();
      picker.start();
      (window as unknown as { __nfPicker: typeof picker }).__nfPicker = picker;
    });

    // Overlay exists but starts hidden until the first hover fires.
    expect(await page.locator('#nf-pick-outline').count()).toBe(1);

    // Hover the first job card. The card's box determines where the
    // overlay should end up.
    const card = page.locator('article.job').first();
    const cardBox = await card.boundingBox();
    expect(cardBox, 'card must have a bounding box').not.toBeNull();
    await page.mouse.move(
      cardBox!.x + cardBox!.width / 2,
      cardBox!.y + cardBox!.height / 2,
    );

    // Wait for the overlay to leave its initial hidden/zero-size state.
    await page.waitForFunction(() => {
      const o = document.getElementById('nf-pick-outline');
      if (!o) return false;
      return o.style.display !== 'none' && parseFloat(o.style.width) > 0;
    });

    const overlayRect = await page.evaluate(() => {
      const o = document.getElementById('nf-pick-outline')!;
      const r = o.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    expect(overlayRect.width).toBeGreaterThan(0);
    expect(overlayRect.height).toBeGreaterThan(0);

    // The overlay should align with the hovered card. Use a tolerance —
    // CSS transitions on the overlay's position are intentional and don't
    // matter for "is the user seeing the right thing."
    expect(Math.abs(overlayRect.x - cardBox!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(overlayRect.y - cardBox!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(overlayRect.width - cardBox!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(overlayRect.height - cardBox!.height)).toBeLessThanOrEqual(2);

    // Stop the picker — overlay must be gone, listeners must not fire.
    await page.evaluate(() => {
      (window as unknown as { __nfPicker: { stop(): void } }).__nfPicker.stop();
    });

    expect(await page.locator('#nf-pick-outline').count()).toBe(0);

    // Moving the mouse after stop() must not re-create the overlay.
    await page.mouse.move(10, 10);
    await page.mouse.move(
      cardBox!.x + cardBox!.width / 2,
      cardBox!.y + cardBox!.height / 2,
    );
    expect(await page.locator('#nf-pick-outline').count()).toBe(0);

    // Sanity: no .filt / .restored / picker classes left on the page itself.
    const dirty = await page.evaluate(() =>
      document.querySelectorAll('.nf-pick-outline, [data-nf-picked]').length,
    );
    expect(dirty).toBe(0);

    await browser.close();
  });
});
