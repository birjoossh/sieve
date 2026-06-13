// 4.11 — SW-relayed SPA navigation (tabs.onUpdated → spaNavigated message).
//
// The content script's history patch lives in the ISOLATED world, so a
// page-realm pushState — i.e. every real SPA, LinkedIn included — never
// triggers it (memory.md 2026-06-06; reproduced live in 4.10: filters
// survived in ctx but applied to disconnected pre-navigation elements).
// The SW relays tabs.onUpdated URL changes as a `spaNavigated` message.
//
// page.evaluate runs in the MAIN world, exactly like a real SPA router —
// this spec fails without the relay.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.11 — SPA route change re-detects via SW relay', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('page-realm pushState → re-detect fires, filters survive', async () => {
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Tag the live filtered wrappers. A no-op SPA URL change (same item-set,
    // same fingerprint — LinkedIn does this on every ?currentJobId click)
    // must NOT tear the renderer down and rebuild it: the wrappers below
    // should be the SAME nodes afterwards, still carrying this marker. A
    // rebuild would recreate them without it.
    await env.fixture.evaluate(() => {
      document
        .querySelectorAll('.filt')
        .forEach((el, i) => ((el as HTMLElement).dataset['nfProbe'] = String(i)));
    });

    const redetect = env.fixture.waitForEvent('console', {
      predicate: (m) => m.text().includes('url changed → re-detect'),
      timeout: 10_000,
    });
    // Main-world pushState: invisible to the isolated-world history patch;
    // only the SW's tabs.onUpdated relay can deliver this.
    await env.fixture.evaluate(() => {
      history.pushState({}, '', '/rolecast.html?spa-page=2');
    });
    await redetect;

    // Same fingerprint re-mount carries the live filter set over
    // (memory.md 2026-06-06) — the page stays filtered without any panel
    // round-trip.
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
    await expect(env.panel.locator('.chip[data-phrase="mandatory Mandarin"]')).toHaveCount(1);

    // The no-op re-detect reused the existing renderer: all three tagged
    // wrappers survive. (Before the idempotence guard, mount() unconditionally
    // disconnected the renderer and rebuilt these as fresh, untagged nodes.)
    const reusedWrappers = await env.fixture.evaluate(
      () => document.querySelectorAll('.filt[data-nf-probe]').length,
    );
    expect(reusedWrappers).toBe(3);
  });
});
