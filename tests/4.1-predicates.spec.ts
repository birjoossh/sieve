// 4.1 — Extended Predicate kinds + safe-regex guard.
//
// Gate from tasks.md:
//   "evaluate each predicate kind on fixture data; pathological regex
//    rejected with a typed error."
//
// Predicate kinds covered: containsAny (regression), regex, lessThan,
// greaterThan, equals, oneOf. Evaluations run against rolecast.html with a
// custom schema that exposes `comp` (numeric extraction) in addition to
// the stub-schema's title/company/location/snippet fields.
//
// Numeric extraction: parseFirstNumber pulls the first contiguous number
// out of the text. For comp values like "$180k–$220k" that's the lower
// bound — same heuristic the slider in 4.4 will key off.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const FP = 'fixture:rolecast:v1';

interface VerdictTally {
  passing: number;
  filtered: number;
  reasons: string[];
}

async function evaluateWith(
  filter: Record<string, unknown>,
): Promise<VerdictTally> {
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
      const verdicts = nf.evaluate(schema, items, [f as never]);
      const tally: VerdictTally = { passing: 0, filtered: 0, reasons: [] };
      for (const v of verdicts.values()) {
        if (v.state === 'passing') tally.passing += 1;
        if (v.state === 'filtered') {
          tally.filtered += 1;
          if (v.reason) tally.reasons.push(v.reason);
        }
      }
      return tally;
    }, filter);
  } finally {
    await browser.close();
  }
}

/** Like evaluateWith, but against an inline list built from `texts` — one
 *  card per string — so predicates can be probed on exact real-world values
 *  (thousands separators, split words) the fixture doesn't carry. */
async function evaluateOnTexts(
  texts: string[],
  filter: Record<string, unknown>,
): Promise<VerdictTally> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate(({ texts, f }) => {
      const list = document.createElement('ul');
      list.className = 'cards';
      for (const t of texts) {
        const li = document.createElement('li');
        li.className = 'card';
        const span = document.createElement('span');
        span.className = 'value';
        span.textContent = t;
        li.appendChild(span);
        list.appendChild(li);
      }
      document.body.appendChild(list);
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const schema = {
        fingerprint: 'fixture:inline:v1',
        layout: 'list' as const,
        itemSetSelector: '.cards',
        itemSelector: '.cards > .card',
        fields: { value: { kind: 'text' as const, selector: '.value' } },
        source: 'stub' as const,
        discoveredAt: 0,
      };
      const items = nf.findItems(schema);
      const verdicts = nf.evaluate(schema, items, [f as never]);
      const tally: VerdictTally = { passing: 0, filtered: 0, reasons: [] };
      for (const v of verdicts.values()) {
        if (v.state === 'passing') tally.passing += 1;
        if (v.state === 'filtered') {
          tally.filtered += 1;
          if (v.reason) tally.reasons.push(v.reason);
        }
      }
      return tally;
    }, { texts, f: filter });
  } finally {
    await browser.close();
  }
}

function inlineFilter(predicate: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'f',
    fingerprint: 'fixture:inline:v1',
    polarity: 'exclude',
    field: 'value',
    predicate,
    deep: false,
    saved: false,
  };
}

test.describe('4.1 — predicate kinds + safe-regex', () => {
  test('regex: case-insensitive /Mandarin/ on snippet → 3 filtered (cards 1, 3, 5)', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'snippet',
      predicate: { op: 'regex', pattern: 'Mandarin', flags: 'i' },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(3);
    expect(t.passing).toBe(7);
    // Every filtered card surfaced "Mandarin" (case-preserving from the source).
    for (const r of t.reasons) expect(r.toLowerCase()).toContain('mandarin');
  });

  test('lessThan: comp < 150 → cards 3 (130), 7 (0), 8 (140) filtered = 3', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'comp',
      predicate: { op: 'lessThan', value: 150 },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(3);
    expect(t.passing).toBe(7);
    expect(t.reasons.every((r) => r.includes(' < 150'))).toBe(true);
  });

  test('greaterThan: comp > 200 → cards 5 (210) filtered = 1', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'comp',
      predicate: { op: 'greaterThan', value: 200 },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(1);
    expect(t.reasons[0]).toContain('210 > 200');
  });

  test('equals: location == "Remote" → 4 filtered (cards 2, 6, 7, 10) — "Remote (US)" not exact', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'location',
      predicate: { op: 'equals', value: 'Remote' },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(4);
    expect(t.reasons).toEqual(['Remote', 'Remote', 'Remote', 'Remote']);
  });

  test('oneOf: location in {Berlin, London, Singapore} → 3 filtered (cards 3, 8, 9)', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'location',
      predicate: { op: 'oneOf', values: ['Berlin', 'London', 'Singapore'] },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(3);
    expect(new Set(t.reasons)).toEqual(new Set(['Berlin', 'London', 'Singapore']));
  });

  test('containsAny (regression) — still works after the union expansion', async () => {
    const t = await evaluateWith({
      id: 'f',
      fingerprint: FP,
      polarity: 'exclude',
      field: 'snippet',
      predicate: { op: 'containsAny', phrases: ['unpaid'] },
      deep: false,
      saved: false,
    });
    expect(t.filtered).toBe(1);
    expect(t.reasons[0]).toBe('unpaid');
  });

  test('thousands separators: "HK$2,000" parses to 2000 for greaterThan/lessThan', async () => {
    // Carousell regression: the bare number pattern stopped at the comma
    // and read 2, so "Price > 1500" never fired and "Price < 3" always did.
    const gt = await evaluateOnTexts(
      ['HK$2,000', 'HK$900'],
      inlineFilter({ op: 'greaterThan', value: 1500 }),
    );
    expect(gt.filtered).toBe(1);
    expect(gt.passing).toBe(1);
    expect(gt.reasons[0]).toBe('2000 > 1500');

    const lt = await evaluateOnTexts(
      ['HK$2,000', 'HK$2,600'],
      inlineFilter({ op: 'lessThan', value: 2500 }),
    );
    expect(lt.filtered).toBe(1);
    expect(lt.passing).toBe(1);
    expect(lt.reasons[0]).toBe('2000 < 2500');
  });

  test('thousands separators: comma groups + decimals parse to the full value', async () => {
    const t = await evaluateOnTexts(
      ['1,234.56', '1,234,567.89'],
      inlineFilter({ op: 'greaterThan', value: 1234 }),
    );
    expect(t.filtered).toBe(2);
    expect(new Set(t.reasons)).toEqual(
      new Set(['1234.56 > 1234', '1234567.89 > 1234']),
    );
  });

  test('regression: "$180k–$220k" still parses to 180 (k-suffix not scaled — 4.4 slider semantics)', async () => {
    const t = await evaluateOnTexts(
      ['$180k–$220k'],
      inlineFilter({ op: 'lessThan', value: 200 }),
    );
    expect(t.filtered).toBe(1);
    expect(t.reasons[0]).toBe('180 < 200');
  });

  test('containsAny squash: phrase "Macbook" hides an item titled "Mac Book"', async () => {
    const t = await evaluateOnTexts(
      ['Mac Book Pro 2021 — great condition', 'Dell XPS 13'],
      inlineFilter({ op: 'containsAny', phrases: ['Macbook'] }),
    );
    expect(t.filtered).toBe(1);
    expect(t.passing).toBe(1);
    // The reported trigger stays the user's phrase, not the squashed text.
    expect(t.reasons[0]).toBe('Macbook');
  });

  test('containsAny squash: multi-word phrase "mac book" hides "MacBook"', async () => {
    const t = await evaluateOnTexts(
      ['MacBook Air M2', 'ThinkPad X1'],
      inlineFilter({ op: 'containsAny', phrases: ['mac book'] }),
    );
    expect(t.filtered).toBe(1);
    expect(t.passing).toBe(1);
    expect(t.reasons[0]).toBe('mac book');
  });

  test('containsAny squash: no NEW cross-word false positives; "so up"→"soup" is accepted collateral', async () => {
    // "rust" already matches "frustrating" via plain substring — the squash
    // path must not widen that class of hit. Squashing only merges words,
    // so the one behavior it adds is a spaced phrase matching its joined
    // form: documented and accepted.
    const plain = await evaluateOnTexts(
      ['a frustrating experience', 'rust belt tour'],
      inlineFilter({ op: 'containsAny', phrases: ['rust'] }),
    );
    expect(plain.filtered).toBe(2); // both hit via plain substring, pre-existing behavior

    const collateral = await evaluateOnTexts(
      ['tomato soup recipe', 'sandwich platter'],
      inlineFilter({ op: 'containsAny', phrases: ['so up'] }),
    );
    expect(collateral.filtered).toBe(1); // "soup" merges to match "so up" — accepted
    expect(collateral.passing).toBe(1);
    expect(collateral.reasons[0]).toBe('so up');
  });

  test('safe-regex: pathological pattern (a+)+ rejected with UnsafeRegexError', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const cases = [
          { pattern: '(a+)+', expectReject: true },
          { pattern: '(.*)*', expectReject: true },
          { pattern: '(\\w+)+', expectReject: true },
          { pattern: '(a|b+)+', expectReject: true },
          { pattern: '(.+){2,}', expectReject: true },
          { pattern: 'a'.repeat(300), expectReject: true }, // length cap
          { pattern: '', expectReject: true }, // empty
          { pattern: '[', expectReject: true }, // bad syntax
          { pattern: 'Mandarin', expectReject: false },
          { pattern: '\\d+', expectReject: false },
          { pattern: '(ab)+', expectReject: false }, // single quantifier outside is fine
        ];
        return cases.map((c) => {
          try {
            nf.safeCompileRegex(c.pattern);
            return { pattern: c.pattern, ok: true, reason: null };
          } catch (err) {
            return {
              pattern: c.pattern,
              ok: false,
              reason: err instanceof Error ? err.name : 'unknown',
            };
          }
        });
      });
      for (let i = 0; i < result.length; i++) {
        const r = result[i];
        if (!r) continue;
        if (i < 8) {
          // The unsafe ones.
          expect(r.ok, `pattern "${r.pattern}" should be rejected`).toBe(false);
          expect(r.reason).toBe('UnsafeRegexError');
        } else {
          expect(r.ok, `pattern "${r.pattern}" should compile`).toBe(true);
        }
      }
    } finally {
      await browser.close();
    }
  });

  test('rejected regex disables only that filter; the rest keep evaluating', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const schema = {
          fingerprint: 'fixture:rolecast:v1',
          layout: 'list' as const,
          itemSetSelector: '.joblist',
          itemSelector: '.joblist > .job',
          fields: { snippet: { kind: 'text' as const, selector: '.snippet' } },
          source: 'stub' as const,
          discoveredAt: 0,
        };
        const items = nf.findItems(schema);
        const bad = {
          id: 'bad',
          fingerprint: 'fixture:rolecast:v1',
          polarity: 'exclude' as const,
          field: 'snippet',
          predicate: { op: 'regex' as const, pattern: '(a+)+' },
          deep: false,
          saved: false,
        };
        const good = {
          id: 'good',
          fingerprint: 'fixture:rolecast:v1',
          polarity: 'exclude' as const,
          field: 'snippet',
          predicate: { op: 'containsAny' as const, phrases: ['Mandarin'] },
          deep: false,
          saved: false,
        };
        const errors: Array<{ filterId: string; message: string }> = [];
        const verdicts = nf.evaluate(schema, items, [bad, good], undefined, (e) =>
          errors.push(e),
        );
        const filtered = [...verdicts.values()].filter((v) => v.state === 'filtered').length;
        return { errors, filtered, total: verdicts.size };
      });
      // The unsafe regex sits out with a typed per-filter error…
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.filterId).toBe('bad');
      expect(result.errors[0]!.message).toContain('UnsafeRegexError');
      // …while the containsAny filter still hides the Mandarin cards.
      expect(result.total).toBe(10);
      expect(result.filtered).toBeGreaterThanOrEqual(1);
    } finally {
      await browser.close();
    }
  });
});
