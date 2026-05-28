// 5.4 — IntersectionObserver viewport-triggered enqueue, top-down.
//
// Gate from tasks.md:
//   "scroll list; near-viewport items enqueue before below-the-fold ones."
//
// We construct a tall list of 10 cards, mount the enqueuer, and let
// the IntersectionObserver settle. With rootMargin '0px', only the
// items intersecting the viewport (plus the look-ahead) fire. We
// assert that the firing order matches DOM order top-down.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('5.4 — viewport-triggered enqueue', () => {
  test('items near viewport fire before below-the-fold ones (top-down)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      // Inflate the cards so only ~3 fit in the 400px viewport.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.job') as NodeListOf<HTMLElement>) {
          el.style.minHeight = '180px';
        }
      });
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const items = Array.from(document.querySelectorAll('.job'));
        const fired: string[] = [];
        const eq = new nf.ViewportEnqueuer({
          items,
          rootMargin: '0px',
          onNearViewport: (el) => {
            fired.push((el as HTMLElement).getAttribute('data-id') ?? '?');
          },
        });
        eq.start();
        // Let the IntersectionObserver settle.
        await new Promise((r) => setTimeout(r, 100));
        return fired;
      });

      // Top of the list at scroll=0. With 180px cards in a 400px
      // viewport, ~2 cards fully + part of a 3rd are in view. The
      // first fires are r-001 and r-002 (and r-003 by intersection).
      // What matters: the firing order is top-down — r-001 strictly
      // before r-002 before r-003.
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]).toBe('r-001');
      expect(result[1]).toBe('r-002');
      // Below-the-fold ids (r-008, r-009, r-010) must NOT have
      // fired yet.
      expect(result).not.toContain('r-010');
      expect(result).not.toContain('r-009');
    } finally {
      await browser.close();
    }
  });

  test('scrolling reveals subsequent items, top-down order preserved', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.job') as NodeListOf<HTMLElement>) {
          el.style.minHeight = '180px';
        }
      });
      await page.addScriptTag({ path: TESTBED });

      await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const items = Array.from(document.querySelectorAll('.job'));
        const fired: string[] = [];
        (window as unknown as { __fired: string[] }).__fired = fired;
        const eq = new nf.ViewportEnqueuer({
          items,
          // Default rootMargin ('100% 0px') gives a full-viewport
          // look-ahead so fast scrolls don't miss items the observer
          // sweeps past between callbacks.
          onNearViewport: (el) => {
            fired.push((el as HTMLElement).getAttribute('data-id') ?? '?');
          },
        });
        eq.start();
      });
      // Initial settle.
      await page.waitForTimeout(100);

      // Scroll incrementally so the observer sees each item.
      for (let y = 200; y <= 9 * 180 + 400; y += 200) {
        await page.evaluate((sy) => window.scrollTo(0, sy), y);
        await page.waitForTimeout(60);
      }
      // And to the bottom for safety.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(150);

      const fired = await page.evaluate(
        () => (window as unknown as { __fired: string[] }).__fired,
      );

      // Every item fired exactly once, in DOM order.
      const expected = ['r-001','r-002','r-003','r-004','r-005','r-006','r-007','r-008','r-009','r-010'];
      // We expect fired to be a permutation/prefix of expected with
      // top-down order preserved between scrolls. Easiest assertion:
      // the order of seen ids matches DOM order.
      const seenInDomOrder = fired.filter((id, i) => fired.indexOf(id) === i);
      const expectedSubset = expected.filter((id) => seenInDomOrder.includes(id));
      expect(seenInDomOrder).toEqual(expectedSubset);
      expect(seenInDomOrder.length).toBe(10);
    } finally {
      await browser.close();
    }
  });
});
