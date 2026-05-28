// 2.2 — content/detect.ts classify(container) → LayoutKind from computed
// style (display + flex-direction + overflow-x).
//
// Gate from tasks.md:
//   classify 3 fixtures → expected LayoutKind for each.
//
// Composes with 2.1: detect() picks the container, classify() labels it.
// We do both inside the page so the live computed style — not parsed
// CSS — is what gets checked.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

interface Case {
  name: string;
  file: string;
  container: string;
  expected: 'list' | 'carousel' | 'grid';
}

const CASES: Case[] = [
  {
    name: 'rolecast — block-flow list',
    file: 'rolecast.html',
    container: '.joblist',
    expected: 'list',
  },
  {
    name: 'shopcast — horizontally-scrolling flex track',
    file: 'carousel.html',
    container: '.carousel-track',
    expected: 'carousel',
  },
  {
    name: 'coursemap — CSS grid',
    file: 'grid.html',
    container: '.cs-grid',
    expected: 'grid',
  },
];

test.describe('2.2 — classify()', () => {
  for (const c of CASES) {
    test(`${c.name} → ${c.expected}`, async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, c.file)).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate((containerSel) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const detected = nf.detect(document);
        const fromSelector = document.querySelector(containerSel);
        return {
          fromDetect: detected ? nf.classify(detected) : null,
          fromSelector: fromSelector ? nf.classify(fromSelector) : null,
          detectMatched: detected != null && detected === fromSelector,
        };
      }, c.container);

      // Sanity: 2.1 still picks the same container we're explicitly classifying.
      expect(result.detectMatched, 'detect() should agree with the test selector').toBe(true);
      expect(result.fromDetect).toBe(c.expected);
      expect(result.fromSelector).toBe(c.expected);

      await browser.close();
    });
  }
});
