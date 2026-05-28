// 1.4 — renderer wraps filtered items in `.filt` + injects horizontal sliver.
//        Passing items must be byte-identical to the fixture.
//
// Gate from tasks.md:
//   count `.sliver` elements = 5; count `.job:not(.filt .job)` = 5;
//   passing card outerHTML byte-identical to fixture.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'rolecast.html')).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const FILTERS_INIT = [
  {
    id: 'f-mandarin',
    field: 'snippet',
    predicate: { op: 'containsAny', phrases: ['mandatory Mandarin'] },
  },
  {
    id: 'f-unpaid',
    field: 'snippet',
    predicate: { op: 'containsAny', phrases: ['unpaid', 'no compensation'] },
  },
] as const;

test.describe('1.4 — renderer slivers (list layout)', () => {
  test('5 .sliver, 5 unwrapped passing cards, passing outerHTML untouched', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);

    // Snapshot every item's outerHTML by data-id *before* any extension code
    // runs. The expectation: passing items still match these snapshots
    // exactly after the renderer mutates the page.
    const beforeById = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll('.joblist > .job'))) {
        const id = el.getAttribute('data-id');
        if (id) out[id] = el.outerHTML;
      }
      return out;
    });

    await page.addScriptTag({ path: TESTBED });

    await page.evaluate((filters) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const built = filters.map((f) => nf.makeFilter(f));
      nf.mountRenderer(built);
    }, FILTERS_INIT as unknown as Array<Parameters<typeof window['__nf']['makeFilter']>[0]>);

    // Gate 1: exactly 5 .sliver elements rendered.
    await expect(page.locator('.sliver')).toHaveCount(5);

    // Gate 2: exactly 5 .job elements NOT inside a .filt (= passing items).
    // We assert via evaluate so the count is in-DOM, not a Playwright
    // engine query that could re-walk and miss subtleties.
    const counts = await page.evaluate(() => {
      const allJobs = document.querySelectorAll('.job');
      const wrappedJobs = document.querySelectorAll('.filt > .job');
      return {
        allJobs: allJobs.length,
        wrappedJobs: wrappedJobs.length,
        unwrappedJobs: allJobs.length - wrappedJobs.length,
        filtWrappers: document.querySelectorAll('.filt').length,
        slivers: document.querySelectorAll('.sliver').length,
      };
    });
    expect(counts.allJobs).toBe(10);
    expect(counts.wrappedJobs).toBe(5);
    expect(counts.unwrappedJobs).toBe(5);
    expect(counts.filtWrappers).toBe(5);
    expect(counts.slivers).toBe(5);

    // Gate 3: passing cards' outerHTML is byte-identical to the fixture.
    // Filtered cards' outerHTML can differ (they get the .nf-card-hidden
    // helper class) since wrapping is what filtering is for.
    const PASSING_IDS = ['r-002', 'r-004', 'r-006', 'r-008', 'r-010'];
    const FILTERED_IDS = ['r-001', 'r-003', 'r-005', 'r-007', 'r-009'];

    const afterById = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll('.job'))) {
        const id = el.getAttribute('data-id');
        if (id) out[id] = el.outerHTML;
      }
      return out;
    });

    for (const id of PASSING_IDS) {
      expect(afterById[id], `passing ${id} outerHTML must be byte-identical`).toBe(
        beforeById[id],
      );
    }
    // Sanity: filtered items WERE modified (otherwise the renderer would
    // have done nothing and the byte-identical check would be vacuous).
    for (const id of FILTERED_IDS) {
      expect(afterById[id], `filtered ${id} should have been touched`).not.toBe(
        beforeById[id],
      );
    }

    // Slivers carry the reason text — useful smoke for downstream 1.7.
    const sliverTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.sliver')).map(
        (s) => s.textContent ?? '',
      ),
    );
    expect(sliverTexts.filter((t) => t.includes('mandatory Mandarin')).length).toBe(3);
    expect(sliverTexts.filter((t) => t.includes('unpaid')).length).toBe(1);
    expect(sliverTexts.filter((t) => t.includes('no compensation')).length).toBe(1);

    await browser.close();
  });
});
