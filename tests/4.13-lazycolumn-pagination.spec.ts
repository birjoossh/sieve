// 4.13 — filters keep applying across LazyColumn pagination (user-reported).
//
// On linkedin.com/jobs/search-results/ the next-page action REPLACES a
// nested wrapper inside the LazyColumn — same URL (no SPA relay), same
// itemSet element (no re-detect). Before the fix, MutationWatcher observed
// the itemSet with childList only: the new cards (children of the swapped
// wrapper, not of the itemSet) never reached onItemsAdded, ctx.items kept
// the disconnected page-1 cards, and the panel sat at HIDDEN (0) with the
// chip still visible — exactly the user's screenshot.
//
// fixtures/linkedin-paginated-lazycolumn.html models that DOM; the
// `linkedin.test` host alias makes LINKEDIN_JOBS_NEW_STUB (v2, detached
// render mode) engage, so this exercises the production LinkedIn path.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.13 — LazyColumn pagination keeps filters applied', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv({
      fixturePath: '/linkedin-paginated-lazycolumn.html',
      hostname: 'linkedin.test',
    });
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('phrase filter re-applies to page-2 cards; page-1 ghosts pruned', async () => {
    await env.panel.fill('input[data-input="phrase"]', 'mandarin');
    await env.panel.click('button.phrase-add');

    // Page 1: exactly one card mentions mandarin (2001). v2 stub renders
    // detached, so collapsed cards carry .nf-filt-item, never .filt.
    const collapsed = env.fixture.locator('[role="button"].nf-filt-item:not(.nf-restored)');
    await expect(collapsed).toHaveCount(1);
    await expect(
      env.fixture.locator('[componentkey="job-card-component-ref-2001"].nf-filt-item'),
    ).toHaveCount(1);

    await env.fixture.click('#next-page');

    // Page 2: two of the swapped-in cards match (2101, 2103) and must
    // collapse without any panel interaction or reload.
    await expect(collapsed).toHaveCount(2);
    await expect(
      env.fixture.locator('[componentkey="job-card-component-ref-2101"].nf-filt-item'),
    ).toHaveCount(1);
    await expect(
      env.fixture.locator('[componentkey="job-card-component-ref-2103"].nf-filt-item'),
    ).toHaveCount(1);
    expect(await env.fixture.locator('.filt').count()).toBe(0);

    // Panel reflects the new page only — disconnected page-1 cards must
    // not linger as ghost rows.
    await expect(env.panel.locator('#hidden-list .section-h')).toHaveText('Hidden (2)');
    await expect(env.panel.locator('.hidden-row')).toHaveCount(2);
  });
});
