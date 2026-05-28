// 3.4 — Panel BYO-key field + provider select.
//
// Gate from tasks.md:
//   "enter key; reload extension; key persists; never appears in any message
//    payload other than the provider call."
//
// Tested via the full-extension Playwright env (real chrome.storage.local,
// real panel page). Two concerns split into two tests:
//
//   1. Persistence — save a known key in the LLM-settings UI, close and
//      re-open the panel, assert the input still carries the value.
//   2. Privacy — install spies on chrome.runtime.sendMessage and
//      chrome.tabs.sendMessage in the panel page, exercise every flow the
//      panel currently emits (enable, set filters, set mode, set item
//      restored), assert the secret key value never appears in any captured
//      payload. The only place the key is allowed to surface is the
//      outbound provider `fetch` (SW-side) — which goes nowhere near the
//      runtime/tabs bus.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

const TEST_KEY = 'sk-ant-test-PANEL-PRIVACY-fakekey-xyz789';
const TEST_MODEL = 'claude-test-model-3000';

test.describe('3.4 — panel LLM settings (BYO key + provider)', () => {
  test('save → close + reopen panel → key persists in storage.local', async () => {
    const env = await setupExtEnv();
    try {
      // The LLM settings section is visible on first panel render.
      await env.panel.waitForSelector('[data-role="llm-settings"]', { timeout: 5_000 });
      // Initially: no settings saved → status = "(not configured)".
      await expect(env.panel.locator('[data-role="llm-status"]')).toHaveText('(not configured)');

      // Type provider + key + model, save.
      await env.panel.selectOption('[data-input="provider"]', 'anthropic');
      await env.panel.fill('[data-input="api-key"]', TEST_KEY);
      await env.panel.fill('[data-input="model"]', TEST_MODEL);
      await env.panel.click('[data-action="save-llm-settings"]');

      // Status flips to "(saved)".
      await expect(env.panel.locator('[data-role="llm-status"]')).toHaveText('(saved)');

      // Close the panel and open a fresh panel tab — chrome.storage.local
      // is per-extension, not per-page, so the saved settings must reappear.
      await env.panel.close();
      const reopened = await env.context.newPage();
      await reopened.goto(`chrome-extension://${env.extId}/panel.html`);

      await reopened.waitForSelector('[data-role="llm-settings"]', { timeout: 5_000 });
      await expect(reopened.locator('[data-role="llm-status"]')).toHaveText('(saved)');

      // Provider + key + model preselected from storage.
      const provider = await reopened.locator('[data-input="provider"]').inputValue();
      expect(provider).toBe('anthropic');
      const key = await reopened.locator('[data-input="api-key"]').inputValue();
      expect(key).toBe(TEST_KEY);
      const model = await reopened.locator('[data-input="model"]').inputValue();
      expect(model).toBe(TEST_MODEL);

      // Clear removes the saved settings; status reverts.
      await reopened.click('[data-action="clear-llm-settings"]');
      await expect(reopened.locator('[data-role="llm-status"]')).toHaveText('(not configured)');
      const keyAfterClear = await reopened.locator('[data-input="api-key"]').inputValue();
      expect(keyAfterClear).toBe('');
    } finally {
      await env.teardown();
    }
  });

  test('key never appears in any chrome.runtime / chrome.tabs message payload', async () => {
    const env: ExtEnv = await setupExtEnv();
    try {
      await enableAndWaitForContent(env);

      // Install message spies BEFORE we save the key, so the save itself
      // is also covered.
      await env.panel.evaluate(() => {
        interface Spy {
          channel: 'runtime' | 'tabs';
          args: unknown[];
        }
        (window as unknown as { __nfMsgSpy: Spy[] }).__nfMsgSpy = [];
        const origRuntime = chrome.runtime.sendMessage.bind(chrome.runtime);
        const origTabs = chrome.tabs.sendMessage.bind(chrome.tabs);
        // Wrap. Each wrapper records its raw args then forwards to the
        // original implementation so the panel keeps working.
        chrome.runtime.sendMessage = ((...args: unknown[]) => {
          (window as unknown as { __nfMsgSpy: Spy[] }).__nfMsgSpy.push({
            channel: 'runtime',
            args,
          });
          return (origRuntime as (...a: unknown[]) => unknown)(...args);
        }) as typeof chrome.runtime.sendMessage;
        chrome.tabs.sendMessage = ((...args: unknown[]) => {
          (window as unknown as { __nfMsgSpy: Spy[] }).__nfMsgSpy.push({
            channel: 'tabs',
            args,
          });
          return (origTabs as (...a: unknown[]) => unknown)(...args);
        }) as typeof chrome.tabs.sendMessage;
      });

      // Save the LLM key.
      await env.panel.fill('[data-input="api-key"]', TEST_KEY);
      await env.panel.click('[data-action="save-llm-settings"]');
      await expect(env.panel.locator('[data-role="llm-status"]')).toHaveText('(saved)');

      // Exercise every panel-emitted message we have wired today.
      // 1) Add a phrase filter (panel → content setFilters).
      await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
      await env.panel.click('button.phrase-add');
      await expect(env.fixture.locator('.sliver')).toHaveCount(3);

      // 2) Toggle display mode (panel → content setDisplayMode).
      await env.panel.click('[data-mode="hide"]');
      await env.panel.click('[data-mode="collapse"]');

      // 3) Restore an item then re-hide it (panel → content setItemRestored).
      await env.fixture.locator('.sliver').first().click();
      await env.fixture.locator('.rehide').first().click();

      // 4) Disable the domain (panel → SW disableDomain).
      await env.panel.click('button[data-action="enable-site"]'); // currently labeled "Disable …"

      // Drain — give Chrome's async dispatch a tick to surface.
      await env.panel.waitForTimeout(150);

      // Inspect the spy log.
      const log = await env.panel.evaluate(() => {
        return (window as unknown as { __nfMsgSpy: Array<{ channel: string; args: unknown[] }> })
          .__nfMsgSpy;
      });
      expect(log.length).toBeGreaterThan(0);

      // The key value must not appear anywhere in any captured arg.
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain(TEST_KEY);

      // Sanity: but the panel still has the key in memory (storage.local).
      const keyAfter = await env.panel.locator('[data-input="api-key"]').inputValue();
      expect(keyAfter).toBe(TEST_KEY);
    } finally {
      await env.teardown();
    }
  });
});
