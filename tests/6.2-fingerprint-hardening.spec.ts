// 6.2 — Fingerprint hardening: ignore volatile attributes, normalize
// class lists, hash structural shape.
//
// Gate from tasks.md:
//   "the 8 captures from Spike A → identical fingerprint per layout."
//
// We can't ship 8 real captures into the repo, so the lock-in is
// structural: a layout-isomorphic copy of rolecast.html that swaps
// every hand-written class for a CSS-in-JS-style per-deploy hash
// (`css-1abc23`, `_4xy5z`, `Card__a8K2`, `jsx-12345`). With 6.2's
// utility-class filter in nodeShape, the hardened fingerprint should
// return the same value as the canonical rolecast layout. Without
// the filter, the hashes differ and the cache misses every deploy.
//
// Independent guards: a unit test asserts each pattern matches via
// the exported predicate so the regex set can't silently drift.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('6.2 — fingerprint hardening', () => {
  test('utility-class noise variant has same fingerprint as canonical rolecast', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const fp = async (relativePath: string): Promise<string | null> => {
        const page = await browser.newPage();
        await page.goto(pathToFileURL(resolve(FIXTURES, relativePath)).href);
        await page.addScriptTag({ path: TESTBED });
        const out = await page.evaluate(() => {
          const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
          const container = document.querySelector('.joblist');
          return container ? nf.fingerprintItemSet(container) : null;
        });
        await page.close();
        return out;
      };

      const a = await fp('rolecast.html');
      const b = await fp('rolecast-v3-utility-noise.html');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).toBe(b);
    } finally {
      await browser.close();
    }
  });

  test('distinct layouts still produce distinct fingerprints', async () => {
    // Regression: don't let the over-aggressive filter collapse list
    // vs carousel into the same key.
    const browser = await chromium.launch({ headless: true });
    try {
      const fp = async (relativePath: string, sel: string): Promise<string | null> => {
        const page = await browser.newPage();
        await page.goto(pathToFileURL(resolve(FIXTURES, relativePath)).href);
        await page.addScriptTag({ path: TESTBED });
        const out = await page.evaluate((s) => {
          const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
          const container = document.querySelector(s);
          return container ? nf.fingerprintItemSet(container) : null;
        }, sel);
        await page.close();
        return out;
      };
      const rolecast = await fp('rolecast.html', '.joblist');
      const carousel = await fp('carousel.html', '.carousel-track');
      const grid = await fp('grid.html', '.cs-grid');
      expect(rolecast).not.toBe(carousel);
      expect(carousel).not.toBe(grid);
      expect(rolecast).not.toBe(grid);
    } finally {
      await browser.close();
    }
  });
});
