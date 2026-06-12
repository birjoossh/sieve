// 5.7 — `checking` renderer state.
//
// Gate from tasks.md:
//   "during a deep scan, near-viewport items show as `checking`; once
//    resolved they switch to sliver or remain passing."

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('5.7 — checking renderer state', () => {
  test('setChecking adds spinner; engine apply with filtered/passing clears it', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        // Mount renderer with empty filters → all 10 cards passing.
        const { renderer, schema } = nf.mountRenderer([]);
        const items = nf.findItems(schema);
        // Snapshot the initial passing count BEFORE setChecking. The
        // summaries() return is a live reference — setChecking
        // mutates entries in place, so reading it later would see
        // the post-checking state.
        const initialPassing = renderer.summaries().filter((s) => s.state === 'passing').length;

        // Mark r-001, r-002, r-003 as checking (deep scan in flight).
        renderer.setChecking('r-001', true);
        renderer.setChecking('r-002', true);
        renderer.setChecking('r-003', true);

        // Visual indicators present.
        const spinnersBefore = document.querySelectorAll('[data-nf-checking]').length;
        // Panel state reflects checking.
        const checkingCount = renderer.summaries().filter((s) => s.state === 'checking').length;

        // Resolve: build a filter that flags r-001 only (Mandarin),
        // re-apply. Engine returns filtered for r-001, passing for r-002
        // and r-003.
        const filter = nf.makeFilter({
          id: 'deep-test',
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['Mandarin'] },
        });
        const verdicts = nf.evaluate(schema, items, [filter]);
        renderer.apply(verdicts);

        const spinnersAfter = document.querySelectorAll('[data-nf-checking]').length;
        const tally: Record<string, number> = {};
        for (const s of renderer.summaries()) {
          tally[s.state] = (tally[s.state] ?? 0) + 1;
        }
        // r-001 should now have a sliver (filtered), r-002/r-003 back to passing.
        const sliverCount = document.querySelectorAll('.sliver').length;

        return {
          initialPassing,
          spinnersBefore,
          checkingCount,
          spinnersAfter,
          tally,
          sliverCount,
        };
      });

      expect(result.initialPassing).toBe(10);
      expect(result.spinnersBefore).toBe(3);
      expect(result.checkingCount).toBe(3);
      expect(result.spinnersAfter).toBe(0);
      // Three Mandarin cards → 3 sliver; rest passing.
      expect(result.sliverCount).toBe(3);
      expect(result.tally).toEqual({ filtered: 3, passing: 7 });
    } finally {
      await browser.close();
    }
  });

  test('setChecking off clears spinner without engine pass', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const { renderer } = nf.mountRenderer([]);
        renderer.setChecking('r-004', true);
        const before = document.querySelectorAll('[data-nf-checking]').length;
        renderer.setChecking('r-004', false);
        const after = document.querySelectorAll('[data-nf-checking]').length;
        return { before, after };
      });
      expect(result.before).toBe(1);
      expect(result.after).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
