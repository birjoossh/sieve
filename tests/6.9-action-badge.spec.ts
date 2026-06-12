// 6.9 — toolbar action badge mirrors the hidden count per tab.
//
// Content's itemStates broadcast already reaches the SW (runtime.sendMessage
// fans out to both the panel and the SW — see memory.md 2026-05-23); the SW
// folds it into chrome.action.setBadgeText({tabId}). Restored items are
// visible again, so only state==='filtered' rows count.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('6.9 — hidden-count badge on the toolbar icon', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  async function badgeText(): Promise<string> {
    const sw = env.context.serviceWorkers()[0]!;
    return sw.evaluate(async (origin: string) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url ?? '').startsWith(origin));
      if (tab?.id === undefined) return 'no-tab';
      return chrome.action.getBadgeText({ tabId: tab.id });
    }, env.fixtureOrigin);
  }

  test('badge shows hidden count; clears when the filter is removed', async () => {
    await expect.poll(badgeText).toBe('');

    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
    await expect.poll(badgeText).toBe('3');

    // Restoring an item makes it visible again — badge drops to 2.
    await env.fixture.locator('.sliver').first().click();
    await expect.poll(badgeText).toBe('2');

    await env.panel.click('.chip[data-phrase="mandatory Mandarin"] .chip-remove');
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
    await expect.poll(badgeText).toBe('');
  });
});
