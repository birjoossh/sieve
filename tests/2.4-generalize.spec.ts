// 2.4 — generalize(picked) — robust selector matching all sibling cards.
//
// Gate from tasks.md:
//   pick one card; generated selector matches all 10 sibling cards on
//   three different fixtures.
//
// Drives generalize() through the testbed against rolecast / carousel /
// grid. For each fixture we pick the *first* same-shape sibling, run
// generalize(), then querySelectorAll on the produced itemSelector and
// check the match set equals the full sibling cluster (10/10/12) and that
// the picked element is one of them.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

interface Case {
  name: string;
  file: string;
  /** Selector for the element we'll "pick". */
  pickSelector: string;
  /** Selector for the container detect() should agree the parent is. */
  expectedContainer: string;
  /** How many siblings of the same shape live in the container. */
  expectedMatchCount: number;
}

const CASES: Case[] = [
  {
    name: 'rolecast — pick one article.job',
    file: 'rolecast.html',
    pickSelector: 'article.job',
    expectedContainer: '.joblist',
    expectedMatchCount: 10,
  },
  {
    name: 'carousel — pick one article.card',
    file: 'carousel.html',
    pickSelector: 'article.card',
    expectedContainer: '.carousel-track',
    expectedMatchCount: 10,
  },
  {
    name: 'grid — pick one article.tile',
    file: 'grid.html',
    pickSelector: 'article.tile',
    expectedContainer: '.cs-grid',
    expectedMatchCount: 12,
  },
];

test.describe('2.4 — generalize()', () => {
  for (const c of CASES) {
    test(`${c.name} → selector matches ${c.expectedMatchCount}`, async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, c.file)).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(
        ({ pickSel, containerSel }) => {
          const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
          const picked = document.querySelector(pickSel) as Element | null;
          if (!picked) return { error: `no element matched ${pickSel}` };
          const gen = nf.generalize(picked);
          if (!gen) return { error: 'generalize returned null' };

          const matched = Array.from(
            document.querySelectorAll(gen.itemSelector),
          );
          const containerOk =
            document.querySelector(gen.itemSetSelector) ===
            document.querySelector(containerSel);

          return {
            itemSetSelector: gen.itemSetSelector,
            itemSelector: gen.itemSelector,
            matchCount: matched.length,
            includesPicked: matched.includes(picked),
            containerOk,
          };
        },
        { pickSel: c.pickSelector, containerSel: c.expectedContainer },
      );

      expect(result.error, `generalize() should produce a selector — got: ${result.error}`).toBeUndefined();
      expect(result.containerOk, `itemSetSelector should resolve to ${c.expectedContainer}`).toBe(true);
      expect(result.matchCount).toBe(c.expectedMatchCount);
      expect(result.includesPicked, 'the picked element must be in the match set').toBe(true);

      await browser.close();
    });
  }
});
