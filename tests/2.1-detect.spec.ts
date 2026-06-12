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
  {
    // Regression: cards with per-deploy CSS-in-JS class tokens
    // (`css-1abc23`, `Card__a8K2`, `jsx-12345`) must still group. Before
    // the volatile-class strip in detect.ts, these fragmented into
    // singletons and detect() returned null → "No list detected."
    name: 'rolecast utility-noise — CSS-in-JS class tokens per card',
    file: 'rolecast-v3-utility-noise.html',
    expected: '.joblist',
    expectedChildren: 5,
  },
  {
    // Regression: real-LinkedIn-shaped page — a nav of identically-classed
    // <li>s (the decoy the old detector picked) plus job cards carrying
    // unique per-item Ember/occlusion tokens. detect() must return the job
    // list, not the nav.
    name: 'linkedin-shaped jobs — per-item tokens + nav decoy',
    file: 'linkedin-jobs.html',
    expected: '.jobs-list',
    expectedChildren: 6,
  },
  {
    // Regression for the live linkedin.com/jobs/search failure ("Detected:
    // list · 1 item"): enormous wrapper <div>s out-scored the real list under
    // the old groupSize×meanDescendants scoring, and the BEM container class
    // `scaffold-layout__list` was wrongly stripped, merging wrappers. detect()
    // must return the results <ul>, not a wrapper. Needs DESCENDANT_CAP + the
    // hash-token strip + the BEM-safe CSS-module pattern together.
    name: 'linkedin search results — giant wrappers + hashed cards',
    file: 'linkedin-search-results.html',
    expected: '.scaffold-layout__list ul',
    expectedChildren: 8,
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
