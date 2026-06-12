// 1.3 — content/engine.ts evaluate() is pure and returns the right verdicts.
//
// Gate from tasks.md:
//   load fixture, call engine with 2 filters; assert 5 filtered, 5 passing
//   (no restored/checking yet).
//
// We load the fixture in a plain Playwright page (no extension), inject the
// testbed bundle, and drive engine.evaluate from inside the page so the DOM
// nodes the engine sees are the real ones the renderer will work with in
// 1.4. Pure-function contract is verified by snapshotting fixture HTML
// before/after the call.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'rolecast.html')).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('1.3 — engine.evaluate', () => {
  test('2 filters split 10 cards into 5 filtered / 5 passing, and the DOM is untouched', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    const beforeHTML = await page.evaluate(
      () => document.querySelector('.joblist')!.outerHTML,
    );

    const result = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const schema = nf.ROLECAST_STUB_SCHEMA;
      const items = nf.findItems(schema);
      const filters = [
        nf.makeFilter({
          id: 'f-mandarin',
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['mandatory Mandarin'] },
        }),
        nf.makeFilter({
          id: 'f-unpaid',
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['unpaid', 'no compensation'] },
        }),
      ];
      const verdicts = nf.evaluate(schema, items, filters);

      // Verdict shape per item, in document order, for richer failure output.
      const perItem = items.map((el) => ({
        id: el.getAttribute('data-id'),
        verdict: verdicts.get(el) ?? null,
      }));

      return {
        tallies: nf.tallyVerdicts(verdicts),
        perItem,
        itemCount: items.length,
      };
    });

    const afterHTML = await page.evaluate(
      () => document.querySelector('.joblist')!.outerHTML,
    );

    expect(result.itemCount, 'fixture should expose 10 items').toBe(10);
    expect(result.tallies, '5 filtered, 5 passing — no other states').toEqual({
      filtered: 5,
      passing: 5,
    });

    // The expected pattern from fixtures/rolecast.html: cards 1, 3, 5 hit
    // the mandarin filter; 7, 9 hit the unpaid filter; 2, 4, 6, 8, 10 pass.
    const states = Object.fromEntries(
      result.perItem.map((p) => [p.id, p.verdict?.state]),
    );
    expect(states).toEqual({
      'r-001': 'filtered',
      'r-002': 'passing',
      'r-003': 'filtered',
      'r-004': 'passing',
      'r-005': 'filtered',
      'r-006': 'passing',
      'r-007': 'filtered',
      'r-008': 'passing',
      'r-009': 'filtered',
      'r-010': 'passing',
    });

    // Surface the "reason" for at least one filtered item — exercises the
    // trigger-phrase propagation the HIDDEN list (1.7) depends on.
    const r1 = result.perItem.find((p) => p.id === 'r-001')!;
    expect(r1.verdict?.reason).toBe('mandatory Mandarin');
    const r7 = result.perItem.find((p) => p.id === 'r-007')!;
    expect(r7.verdict?.reason).toBe('unpaid');

    // Pure-function contract: the engine never touches the DOM.
    expect(afterHTML, 'engine must not mutate DOM').toBe(beforeHTML);

    await browser.close();
  });

  test('whitespace-squashed phrase match: joined "mandatoryMandarin" still hits "Mandatory Mandarin" cards', async () => {
    // Marketplace-style word-split bug ("Macbook" vs "Mac Book"): a phrase
    // matches when haystack and phrase compare equal with all whitespace
    // removed. On the fixture, the joined spelling must hit the same three
    // cards the spaced phrase does, and the surfaced reason stays the
    // user's phrase as typed.
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    const result = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const schema = nf.ROLECAST_STUB_SCHEMA;
      const items = nf.findItems(schema);
      const verdicts = nf.evaluate(schema, items, [
        nf.makeFilter({
          id: 'f-joined',
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['mandatoryMandarin'] },
        }),
      ]);
      return items.map((el) => ({
        id: el.getAttribute('data-id'),
        verdict: verdicts.get(el) ?? null,
      }));
    });

    const filtered = result.filter((p) => p.verdict?.state === 'filtered');
    expect(filtered.map((p) => p.id)).toEqual(['r-001', 'r-003', 'r-005']);
    for (const p of filtered) expect(p.verdict?.reason).toBe('mandatoryMandarin');

    await browser.close();
  });
});
