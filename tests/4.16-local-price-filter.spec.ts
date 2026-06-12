// 4.16 — local price-field detection + generalized numeric filter
// (bugs.md Bug 2: Carousell "Price > 4000" filtered nothing).
//
// Two root causes, both fixed here:
//   1. The panel's numeric filter was hardcoded to a field literally named
//      `comp` (rolecast's), so marketplace pages whose numeric field is
//      `price` never lit up the editor.
//   2. Without an LLM key the local schema had NO fields at all — numeric
//      filtering was impossible exactly where users wanted it.
// detectPriceField() finds the consistently currency-formatted element
// across cards and synthesizes a `price` field locally, no LLM required.
//
// Two layers:
//   (a) Engine — detectPriceField + buildLocalSchema via the testbed on the
//       carousell-grid fixture (HK$ comma-grouped prices, decoy numbers in
//       seller/condition lines), plus a no-currency negative control.
//   (b) Panel UI — real extension, NO LLM key: the numeric section renders
//       "Filter by Price"; above-threshold values hide the right cards.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('4.16 — local price field (engine layer)', () => {
  test('buildLocalSchema on carousell-grid: price field detected, numeric predicate evaluates', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'carousell-grid.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const local = nf.buildLocalSchema(document);
        if (!local) return { error: 'buildLocalSchema returned null' };
        const { schema } = local;
        const items = nf.findItems(schema, document);
        const over2000 = nf.evaluate(schema, items, [
          {
            id: 'f1',
            fingerprint: schema.fingerprint,
            polarity: 'exclude',
            field: 'price',
            predicate: { op: 'greaterThan', value: 2000 },
            deep: false,
            saved: false,
          },
        ]);
        const over4000 = nf.evaluate(schema, items, [
          {
            id: 'f2',
            fingerprint: schema.fingerprint,
            polarity: 'exclude',
            field: 'price',
            predicate: { op: 'greaterThan', value: 4000 },
            deep: false,
            saved: false,
          },
        ]);
        return {
          priceField: schema.fields['price'] ?? null,
          itemCount: items.length,
          filtered2000: nf.tallyVerdicts(over2000)['filtered'] ?? 0,
          filtered4000: nf.tallyVerdicts(over4000)['filtered'] ?? 0,
        };
      });

      if ('error' in result) throw new Error(String(result.error));
      // The consistently currency-formatted element is the price line.
      expect(result.priceField).toEqual({ kind: 'number', selector: 'p.price' });
      expect(result.itemCount).toBe(10);
      // > 2000 (strict): 4500, 6800, 3200, 5000, 2500 — the HK$2,000 card stays.
      expect(result.filtered2000).toBe(5);
      // > 4000 (strict): 4500, 6800, 5000.
      expect(result.filtered4000).toBe(3);
    } finally {
      await browser.close();
    }
  });

  test('no-currency negative control: detectPriceField returns null (no phantom field)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'carousell-grid.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        // Cards with plenty of bare numbers but no currency-marked amount —
        // "3 days ago" / "12 likes" must never become a price field.
        const set = document.createElement('div');
        for (let i = 0; i < 6; i++) {
          const card = document.createElement('div');
          card.className = 'plain-card';
          card.innerHTML =
            '<span class="when">3 days ago</span><span class="likes">12 likes</span>';
          set.appendChild(card);
        }
        document.body.appendChild(set);
        return nf.detectPriceField(set, '.plain-card');
      });

      expect(result).toBeNull();
    } finally {
      await browser.close();
    }
  });
});

test.describe('4.16 — price filter (UI layer, no LLM key)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv({ fixturePath: '/carousell-grid.html' });
    await enableAndWaitForContent(env);
    // Deliberately NO LLM key — this is exactly the reporting user's
    // situation: hint + Re-discover had nothing to improve because the
    // numeric field never existed. Local detection must carry it alone.
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('numeric section binds to the local price field; above-threshold hides the right cards', async () => {
    // The local schema's price field lights up the numeric editor. The
    // fixture classifies as a grid, so hidden cards render the `.ctile`
    // placeholder (not the list `.sliver` bar).
    await expect(env.panel.locator('#numeric-filter')).toContainText('Filter by Price');
    await expect(env.fixture.locator('.ctile')).toHaveCount(0);

    // Hide above 4000 → HK$4,500 / HK$6,800 / HK$5,000 collapse.
    await env.panel.locator('select[data-input="numeric-op"]').selectOption('greaterThan');
    await env.panel.locator('input[data-input="numeric-value"]').fill('4000');
    await env.panel.locator('input[data-input="numeric-enabled"]').check();
    await expect(env.fixture.locator('.ctile')).toHaveCount(3);

    // Lower the threshold to 2000 → 5 cards out (comma-grouped "HK$2,000"
    // parses as 2000, strict > keeps it visible).
    await env.panel.locator('input[data-input="numeric-value"]').fill('2000');
    await expect(env.fixture.locator('.ctile')).toHaveCount(5);

    // Disable → everything restored.
    await env.panel.locator('input[data-input="numeric-enabled"]').uncheck();
    await expect(env.fixture.locator('.ctile')).toHaveCount(0);
  });
});
