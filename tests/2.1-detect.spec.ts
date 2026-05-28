// 2.1 — content/detect.ts repeated-structure heuristic finds the candidate
// item-set on a page.
//
// Gate from tasks.md:
//   detect on rolecast (list), a carousel fixture, a grid fixture → each
//   returns the correct outer container.
//
// Layout classification (`list | carousel | grid`) is 2.2's job; this spec
// only checks that the right *container* element comes back. Driven through
// the same testbed wired in for 1.3+ — no extension lifecycle needed since
// detect is a pure DOM-walk.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

interface Case {
  name: string;
  file: string;
  /** CSS selector that uniquely identifies the expected container. */
  expected: string;
  /** Expected number of repeating-item children inside that container. */
  expectedChildren: number;
}

const CASES: Case[] = [
  {
    name: 'rolecast — list of job cards',
    file: 'rolecast.html',
    expected: '.joblist',
    expectedChildren: 10,
  },
  {
    name: 'shopcast — horizontal product carousel',
    file: 'carousel.html',
    expected: '.carousel-track',
    expectedChildren: 10,
  },
  {
    name: 'coursemap — 4-column course grid',
    file: 'grid.html',
    expected: '.cs-grid',
    expectedChildren: 12,
  },
];

test.describe('2.1 — detect()', () => {
  for (const c of CASES) {
    test(`${c.name} → ${c.expected}`, async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, c.file)).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate((expectedSelector) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const found = nf.detect(document);
        const expected = document.querySelector(expectedSelector);
        return {
          foundTag: found?.tagName ?? null,
          foundClass: found?.className ?? null,
          foundChildCount: found?.children.length ?? null,
          sameNode: found != null && expected != null && found === expected,
          expectedFound: expected != null,
        };
      }, c.expected);

      expect(result.expectedFound, `fixture must contain ${c.expected}`).toBe(true);
      expect(result.sameNode, `detect must return ${c.expected}`).toBe(true);
      expect(result.foundChildCount).toBe(c.expectedChildren);

      await browser.close();
    });
  }
});
