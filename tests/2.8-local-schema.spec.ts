// 2.8 — localizeItemSet() / buildLocalSchema(): no-LLM schema construction.
//
// The discover pipeline used to depend on the LLM for the itemSelector, and
// on real SPA pages (LinkedIn) the LLM returned a selector matching a single
// card ("Detected: list · 1 item"). These helpers build robust selectors from
// detect() alone so the free-text keyword filter works offline / when the LLM
// under-matches. Driven through the same testbed as the other content specs.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('2.8 — local (no-LLM) schema', () => {
  test('buildLocalSchema on live-shaped LinkedIn results → all cards + keyword filter', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'linkedin-search-results.html')).href);
    await page.addScriptTag({ path: TESTBED });

    const result = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const local = nf.buildLocalSchema(document);
      if (!local) return { ok: false as const };
      const items = nf.findItems(local.schema);
      const filter = nf.makeFilter({
        id: 'kw',
        fingerprint: local.schema.fingerprint,
        field: '*',
        predicate: { op: 'containsAny', phrases: ['Volunteer'] },
      });
      const verdicts = nf.evaluate(local.schema, items, [filter]);
      let filtered = 0;
      for (const v of verdicts.values()) if (v.state === 'filtered') filtered += 1;
      return {
        ok: true as const,
        source: local.schema.source,
        itemCount: items.length,
        filteredByVolunteer: filtered,
      };
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('local');
      expect(result.itemCount).toBe(8);
      // Five of the eight seeded cards are "Volunteer: …" roles.
      expect(result.filteredByVolunteer).toBe(5);
    }

    await browser.close();
  });
});
