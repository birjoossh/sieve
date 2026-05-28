// 5.6 — Per-filter deep toggle in panel + first-use ToS warning modal.
//
// Gate from tasks.md:
//   "enable deep on a filter → warning modal shown once; dismiss →
//    remembered."

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('5.6 — deep-scan toggle + first-use ToS modal', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('first enable shows modal; dismiss → remembered (no modal on re-enable)', async () => {
    // Toggle is rendered (schema is set).
    await expect(env.panel.locator('input[data-input="deep-scan"]')).toHaveCount(1);
    // Modal not open initially.
    await expect(env.panel.locator('[data-role="deep-warning-modal"]')).toHaveCount(0);

    // Enable deep — first time, modal opens.
    await env.panel.check('input[data-input="deep-scan"]');
    await expect(env.panel.locator('[data-role="deep-warning-modal"]')).toHaveCount(1);

    // Dismiss the modal.
    await env.panel.click('button[data-action="dismiss-deep-warning"]');
    await expect(env.panel.locator('[data-role="deep-warning-modal"]')).toHaveCount(0);

    // Storage was written.
    const dismissed = await env.panel.evaluate(async () => {
      const r = await chrome.storage.local.get('nf:deep-warning-dismissed');
      return r['nf:deep-warning-dismissed'];
    });
    expect(dismissed).toBe(true);

    // Toggle off → on again → modal must NOT reappear.
    await env.panel.uncheck('input[data-input="deep-scan"]');
    await env.panel.check('input[data-input="deep-scan"]');
    await expect(env.panel.locator('[data-role="deep-warning-modal"]')).toHaveCount(0);
  });
});
