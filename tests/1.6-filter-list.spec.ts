// 1.6 — panel/components/filter-list.ts: add a phrase via the panel; engine
// re-evaluates; sliver count updates.
//
// Full-stack test: real extension loaded, fixture served over http, panel
// drives the content script. Two-direction state check — phrase input
// reflects in the in-page sliver count, then chip removal restores items.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('1.6 — panel filter-list adds + removes phrases', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('add phrase via panel → 3 slivers; remove → 0 slivers', async () => {
    // Initially: extension enabled but no filter → 0 .sliver in the fixture.
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);

    // Type the phrase into the panel input and submit the form.
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');

    // Chip appears in the panel.
    await expect(env.panel.locator('.chip[data-phrase="mandatory Mandarin"]')).toHaveCount(1);

    // Engine re-evaluates in the fixture: cards 1, 3, 5 collapse to slivers.
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Add a second phrase OR'd into the same filter.
    await env.panel.fill('input[data-input="phrase"]', 'unpaid');
    await env.panel.click('button.phrase-add');

    await expect(env.panel.locator('.chip')).toHaveCount(2);
    // Card 7 matches "unpaid" → 4 slivers total. (Card 9 says "no compensation",
    // which we didn't add — so 4, not 5.)
    await expect(env.fixture.locator('.sliver')).toHaveCount(4);

    // Remove the second chip → back to 3.
    await env.panel.click('.chip[data-phrase="unpaid"] .chip-remove');
    await expect(env.panel.locator('.chip')).toHaveCount(1);
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Remove the last chip → no filters → no slivers.
    await env.panel.click('.chip[data-phrase="mandatory Mandarin"] .chip-remove');
    await expect(env.panel.locator('.chip')).toHaveCount(0);
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});
