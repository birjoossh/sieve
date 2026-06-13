// 4.17 — Observer-first detection of a late-hydrating list.
//
// The content script registers at document_end and detects observer-first:
// one immediate attempt, then a MutationObserver that mounts the instant the
// list's first cards appear. This is what lets us filter LinkedIn's cards as
// React renders them instead of waiting for the window 'load' event
// (document_idle) — measured live: cards are present seconds before idle on a
// cold load.
//
// This fixture has NO list at document_end; it injects `.joblist` ~1.2s later
// (the rolecast stub shape). The observer must catch it promptly. The old
// seeded back-off ([0, 1s, 3s] cumulative → retries at 0/1s/4s) would not
// re-attempt between 1s and 4s, so a list arriving at 1.2s sat undetected
// until ~4s — the sub-3.5s assertion below is the regression guard for the
// observer-first path.

import { test, expect } from '@playwright/test';
import { setupExtEnv, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.17 — observer-first detection of a late-hydrating list', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv({ fixturePath: '/late-hydration.html' });
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('list injected after init is detected promptly + is filterable', async () => {
    await env.fixture.bringToFront();
    await env.panel.waitForFunction(
      (origin) => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-action="enable-site"]',
        );
        return btn?.textContent === `Enable on ${new URL(origin).hostname}`;
      },
      env.fixtureOrigin,
      { timeout: 5_000 },
    );
    await env.panel.click('button[data-action="enable-site"]');

    // Reload so the content script injects fresh, then time how long until the
    // panel reports a schema. The list only materializes ~1.2s after load.
    const reloadAt = Date.now();
    await env.fixture.reload();
    await env.panel.waitForFunction(
      () => document.querySelector('[data-role="page-detected"]') !== null,
      undefined,
      { timeout: 8_000 },
    );
    const detectMs = Date.now() - reloadAt;

    // Observer-first catches the list within a frame of its injection (~1.2s);
    // the old fixed back-off would not have retried until ~4s.
    expect(detectMs).toBeLessThan(3_500);

    // The late-hydrated list is fully filterable.
    await env.fixture.bringToFront();
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
  });
});
