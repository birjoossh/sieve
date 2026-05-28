// 4.6 — content/mutations.ts — MutationObserver re-evaluates added items.
//
// Gate from tasks.md:
//   "scroll fixture loads 10 more items → engine re-applies →
//    counts updated."
//
// We use rolecast-paginated.html (5 cards initially, "Load more"
// appends 5 more). With the phrase filter "Mandarin" active, slivers
// go from 3 → 4 as the appended cards include r-009 ("Mandatory
// Mandarin for collaboration with HQ.").

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.6 — MutationObserver re-evaluates added items', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
    // Reuse the enabled origin to navigate to the paginated fixture.
    // Same origin (127.0.0.1:<port>) so the content script auto-injects.
    await env.fixture.goto(`${env.fixtureOrigin}/rolecast-paginated.html`);
    // Wait for the panel to reconcile to the new page.
    await env.panel.waitForFunction(
      () => document.querySelector('[data-role="display-mode"]') !== null,
      undefined,
      { timeout: 5_000 },
    );
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('Load more appends 5 cards → engine re-applies → sliver count grows', async () => {
    // Add the phrase filter.
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');

    // 5 initial cards, 3 match: r-001, r-003, r-005.
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
    await expect(env.fixture.locator('article.job')).toHaveCount(5);

    // Click Load more → 5 more cards appended one-by-one.
    await env.fixture.click('#load-more');

    // After the mutation observer fires + debounces, the engine has
    // evaluated the new cards; r-009 (Mandarin) joins → 4 slivers.
    await expect(env.fixture.locator('article.job')).toHaveCount(10);
    await expect(env.fixture.locator('.sliver')).toHaveCount(4);

    // Cleanup so the suite is order-independent.
    await env.panel.click('.chip[data-phrase="Mandarin"] .chip-remove');
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});
