// 4.2 — Filter.polarity = exclude | keep (positive filters).
//
// Gate from tasks.md:
//   "A `keep` filter on `workplace=Remote` filters out non-Remote items."
//
// The engine has handled both polarities since Slice 1.3 — this slice is a
// behavioural lock-in: an explicit test that asserts the `keep` semantics
// (match = pass, miss = filter), plus the dual case (exclude) so a future
// refactor can't silently invert one without the other.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const FP = 'fixture:rolecast:v1';

interface Tally {
  passing: number;
  filtered: number;
}

async function runFilter(filter: Record<string, unknown>): Promise<Tally> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate((f) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const schema = {
        fingerprint: 'fixture:rolecast:v1',
        layout: 'list' as const,
        itemSetSelector: '.joblist',
        itemSelector: '.joblist > .job',
        fields: {
          location: { kind: 'text' as const, selector: '.location' },
        },
        source: 'stub' as const,
        discoveredAt: 0,
      };
      const items = nf.findItems(schema);
      const verdicts = nf.evaluate(schema, items, [f as never]);
      const t: Tally = { passing: 0, filtered: 0 };
      for (const v of verdicts.values()) {
        if (v.state === 'passing') t.passing += 1;
        if (v.state === 'filtered') t.filtered += 1;
      }
      return t;
    }, filter);
  } finally {
    await browser.close();
  }
}

test.describe('4.2 — Filter.polarity (exclude ⇄ keep)', () => {
  test('keep + equals "Remote" → 4 pass (cards 2, 6, 7, 10); 6 filtered (others)', async () => {
    const t = await runFilter({
      id: 'keep-remote',
      fingerprint: FP,
      polarity: 'keep',
      field: 'location',
      predicate: { op: 'equals', value: 'Remote' },
      deep: false,
      saved: false,
    });
    expect(t.passing).toBe(4);
    expect(t.filtered).toBe(6);
  });

  test('exclude + equals "Remote" inverts: 6 pass, 4 filtered', async () => {
    const t = await runFilter({
      id: 'exclude-remote',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'location',
      predicate: { op: 'equals', value: 'Remote' },
      deep: false,
      saved: false,
    });
    expect(t.passing).toBe(6);
    expect(t.filtered).toBe(4);
  });

  test('keep + oneOf works the same way (any in the set passes)', async () => {
    const t = await runFilter({
      id: 'keep-onsite-asia',
      fingerprint: FP,
      polarity: 'keep',
      field: 'location',
      predicate: { op: 'oneOf', values: ['Shanghai', 'Singapore', 'Taipei'] },
      deep: false,
      saved: false,
    });
    // Cards 1 (Shanghai), 3 (Singapore), 5 (Taipei) → 3 pass; rest filtered.
    expect(t.passing).toBe(3);
    expect(t.filtered).toBe(7);
  });
});
