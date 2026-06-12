// 4.9 — Session phrases survive an in-app navigation (regression).
//
// Bug report: on LinkedIn /jobs/search-results/?keywords=foo, the user typed
// a phrase and saw filtering work. Submitting a new search ("bar") landed
// them on the same path with a different query — and the extension "stopped
// working". No chip in the panel, no slivers in the page.
//
// Three mechanisms contribute:
//   (a) content/index.ts:installSpaNavigationWatcher monkey-patches
//       history.pushState/replaceState, intending to intercept SPA route
//       changes. In an MV3 isolated world this patch only intercepts the
//       content-script's own pushState calls — the page-realm pushState
//       (what the SPA framework calls) is the untouched native function.
//       So on LinkedIn the watcher silently never fires.
//   (b) When the navigation IS a full reload (the path LinkedIn actually
//       takes for the search submit, and the path we can drive
//       deterministically in a test), the content script re-injects fresh
//       on document_idle. ctx.filters is reset to [] before
//       hydrateSavedFilters runs — and with no saved set, it stays empty.
//   (c) The panel's chrome.tabs.onUpdated handler then refresh()es and
//       clobbers state.phrases with content's empty list, so the chip
//       disappears too. The user's only recourse is to retype.
//
// Fix lives in panel.refresh(): snapshot prevPhrases / prevNumeric before
// re-reading content. If the same-origin tab came back with empty filters
// but the panel had typed phrases, preserve them AND re-push via
// pushFilters() so content re-filters the new search results.
//
// This test drives the production path: enable on rolecast, type a phrase,
// reload the fixture tab (a stricter event than pushState — it forces full
// content-script re-init), assert that filtering re-applies WITHOUT a save
// step.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.9 — session phrases survive in-app navigation', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('tab reload with no saved set: panel re-pushes session phrases → filters re-apply', async () => {
    // Sanity: nothing saved for this fingerprint at the start of the test.
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(0);

    // Type a phrase — 3 cards in fixtures/rolecast.html match "Mandarin".
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
    await expect(env.panel.locator('.chip[data-phrase="Mandarin"]')).toHaveCount(1);

    // Reload the fixture tab — same origin, same fingerprint, fresh
    // content-script init. Equivalent to the user hitting Enter in
    // LinkedIn's search box and landing on a new keywords URL.
    await env.fixture.reload();

    // Without the panel-side preservation, content re-mounts with empty
    // filters, panel.refresh() clobbers state.phrases, and both the chip
    // and slivers disappear. The fix: panel snapshots prev state, sees
    // content lost its filter list under the same origin, restores phrases,
    // and re-pushes to content via pushFilters().
    await env.panel.waitForFunction(
      () => document.querySelector('.chip[data-phrase="Mandarin"]') !== null,
      undefined,
      { timeout: 5_000 },
    );
    await expect(env.panel.locator('.chip[data-phrase="Mandarin"]')).toHaveCount(1);
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Cleanup so suite order is independent.
    await env.panel.click('.chip[data-phrase="Mandarin"] .chip-remove');
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });

  test('tab reload without typed phrases: panel does NOT spuriously push (no chip materializes)', async () => {
    // Guard the preservation logic against false positives: if the user
    // never typed anything, a reload shouldn't conjure a chip out of
    // thin air. (Catches a regression where prevPhrases were misread as
    // truthy on a fresh panel.)
    await expect(env.panel.locator('.chip')).toHaveCount(0);
    await env.fixture.reload();
    await env.panel.waitForFunction(
      () => document.querySelector('[data-role="display-mode"]') !== null,
      undefined,
      { timeout: 5_000 },
    );
    await expect(env.panel.locator('.chip')).toHaveCount(0);
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});
