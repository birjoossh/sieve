// 4.3 — Filter composition (AND across filters, OR within a phrase list).
//
// Gate from tasks.md:
//   "3 stacked filters; item survives only if it passes all."
//
// AND across filters: an item passes only when every applicable filter
// says "don't exclude." First-match-wins on the reason (engine.ts).
// OR within a phrase list: containsAny matches on any one phrase.
//
// Tested on rolecast.html with three stacked filters covering three
// distinct fields (snippet / location / comp) and three predicate kinds
// (containsAny / equals / lessThan).

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
  passingIds: string[];
  reasons: string[];
}

async function runFilters(filters: unknown[]): Promise<Tally> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate((fs) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const schema = {
        fingerprint: 'fixture:rolecast:v1',
        layout: 'list' as const,
        itemSetSelector: '.joblist',
        itemSelector: '.joblist > .job',
        fields: {
          title: { kind: 'text' as const, selector: '.title' },
          company: { kind: 'text' as const, selector: '.company' },
          location: { kind: 'text' as const, selector: '.location' },
          comp: { kind: 'number' as const, selector: '.comp' },
          snippet: { kind: 'text' as const, selector: '.snippet' },
        },
        source: 'stub' as const,
        discoveredAt: 0,
      };
      const items = nf.findItems(schema);
      const verdicts = nf.evaluate(schema, items, fs as never[]);
      const out: Tally = { passing: 0, filtered: 0, passingIds: [], reasons: [] };
      for (const [el, v] of verdicts) {
        const id = (el as HTMLElement).getAttribute('data-id') ?? '';
        if (v.state === 'passing') {
          out.passing += 1;
          out.passingIds.push(id);
        } else if (v.state === 'filtered') {
          out.filtered += 1;
          if (v.reason) out.reasons.push(v.reason);
        }
      }
      return out;
    }, filters);
  } finally {
    await browser.close();
  }
}

test.describe('4.3 — composition (AND across filters, OR within phrase list)', () => {
  test('3 stacked filters → only cards 4, 8, 9 survive', async () => {
    // (A) snippet contains "Mandarin" OR "unpaid" → cards 1, 3, 5, 7
    // (B) location == "Remote" (exact)               → cards 2, 6, 7, 10
    // (C) comp < 100 (numeric extract; "stipend"=null, "$0"=0) → card 7
    // Survivors: ids without ANY exclusion = 4, 8, 9.
    const filters = [
      {
        id: 'A',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'snippet',
        predicate: { op: 'containsAny', phrases: ['Mandarin', 'unpaid'] },
        deep: false,
        saved: false,
      },
      {
        id: 'B',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'location',
        predicate: { op: 'equals', value: 'Remote' },
        deep: false,
        saved: false,
      },
      {
        id: 'C',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'comp',
        predicate: { op: 'lessThan', value: 100 },
        deep: false,
        saved: false,
      },
    ];

    const t = await runFilters(filters);
    expect(t.passing).toBe(3);
    expect(new Set(t.passingIds)).toEqual(new Set(['r-004', 'r-008', 'r-009']));
    expect(t.filtered).toBe(7);
  });

  test('OR within phrase list: ["unpaid", "no compensation"] matches both card 7 and card 9', async () => {
    const t = await runFilters([
      {
        id: 'phrases',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'snippet',
        predicate: { op: 'containsAny', phrases: ['unpaid', 'no compensation'] },
        deep: false,
        saved: false,
      },
    ]);
    expect(t.filtered).toBe(2);
    expect(new Set(t.reasons)).toEqual(new Set(['unpaid', 'no compensation']));
  });

  test('AND short-circuits on first exclusion (first-match-wins reason)', async () => {
    // A: exclude all (location equals "" — never matches; so no filter)
    // B: exclude "Mandarin" snippets
    // C: exclude location "Remote"
    // Card 1 (Shanghai, Mandarin): B matches first; reason should be "Mandarin".
    const filters = [
      {
        id: 'A',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'company',
        predicate: { op: 'equals', value: 'NOMATCH' },
        deep: false,
        saved: false,
      },
      {
        id: 'B',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'snippet',
        predicate: { op: 'containsAny', phrases: ['Mandarin'] },
        deep: false,
        saved: false,
      },
      {
        id: 'C',
        fingerprint: FP,
        polarity: 'exclude',
        field: 'location',
        predicate: { op: 'equals', value: 'Shanghai' },
        deep: false,
        saved: false,
      },
    ];
    const t = await runFilters(filters);
    // Card 1 has both Mandarin and Shanghai; B fires first → reason "Mandarin".
    expect(t.reasons).toContain('Mandarin');
    // The 3 Mandarin cards all surface "Mandarin" first, not "Shanghai".
    const shanghaiOnly = t.reasons.filter((r) => r === 'Shanghai');
    expect(shanghaiOnly.length).toBe(0);
  });

  test('cross-fingerprint filter is ignored (engine binds by fingerprint)', async () => {
    const filters = [
      {
        id: 'wrong-fp',
        fingerprint: 'some-other-page',
        polarity: 'exclude',
        field: 'snippet',
        predicate: { op: 'containsAny', phrases: ['Mandarin'] },
        deep: false,
        saved: false,
      },
    ];
    const t = await runFilters(filters);
    expect(t.passing).toBe(10);
    expect(t.filtered).toBe(0);
  });
});
