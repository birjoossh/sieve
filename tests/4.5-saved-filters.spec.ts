// 4.5 — Filter lifecycle: ephemeral (memory) vs saved (storage.sync).
//
// Gate from tasks.md:
//   "save a filter; reload extension; saved filter auto-applies on
//    matching layout."
//
// We save the active filter set (phrases + numeric) under the schema's
// fingerprint, then reload the fixture tab. The content script's
// hydrateSavedFilters() reads storage.sync on init, swaps the empty
// initial filter list for the saved one, and re-renders — slivers
// reappear without the panel having to push.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.5 — saved filters round-trip via storage.sync', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('save → reload tab → saved filters auto-apply', async () => {
    // Initially: extension enabled but no filter → 0 slivers, no
    // saved badge in the panel.
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(0);

    // Add 2 phrases (3+1=4 slivers per rolecast fixture).
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await env.panel.fill('input[data-input="phrase"]', 'unpaid');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(4);

    // Save → "saved" badge appears + Clear-saved button shows.
    await env.panel.click('button[data-action="save-filters"]');
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(1);
    await expect(env.panel.locator('button[data-action="clear-saved-filters"]')).toHaveCount(1);

    // Reload the fixture tab — content script re-injects, hydrates
    // saved filters from storage.sync, and re-renders the slivers
    // without any panel interaction.
    await env.fixture.reload();
    await expect(env.fixture.locator('.sliver')).toHaveCount(4);

    // Panel reflects the round-tripped filters via the content
    // hydrate path. We don't call panel.bringToFront() here —
    // tabs.onActivated(panel) would null the panel's view of the
    // active content tab and wipe state.phrases.
    await expect(env.panel.locator('.chip')).toHaveCount(2);
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(1);

    // Clear saved → reload → no slivers (ephemeral state in panel,
    // but the content script has nothing to hydrate so the page is
    // clean post-reload).
    await env.panel.click('button[data-action="clear-saved-filters"]');
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(0);
    await env.fixture.reload();
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});
