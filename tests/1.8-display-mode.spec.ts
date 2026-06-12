// 1.8 — display modes after the toggle removal (bugs.md Bug 3 feedback).
//
// The COLLAPSE | HIDE segmented control was removed from the panel: with the
// polarity control and per-item restore under Filters, users read it as
// redundant clutter. Default behavior is collapse (sliver bar per hidden
// item). The renderer still honors `setDisplayMode` over the message bus —
// this spec pins both halves:
//   (a) the panel renders NO mode toggle, and
//   (b) collapse stays the default; the bus path still flips `mode-hide`.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('1.8 — display mode (toggle removed, collapse default)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);

    // Seed with phrases → 5 filtered cards (3 mandarin + unpaid + no compensation).
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await env.panel.fill('input[data-input="phrase"]', 'unpaid');
    await env.panel.click('button.phrase-add');
    await env.panel.fill('input[data-input="phrase"]', 'no compensation');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(5);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('panel renders no mode toggle; collapse is the default', async () => {
    // The segmented control is gone — no mode buttons anywhere in the panel.
    await expect(env.panel.locator('.mode-btn')).toHaveCount(0);
    await expect(env.panel.locator('[data-role="display-mode"]')).toHaveCount(0);

    // Default = collapse: slivers visible, no mode-hide on the item-set.
    const slivers = env.fixture.locator('.sliver');
    await expect(slivers).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeVisible();
    }
    await expect(env.fixture.locator('.joblist')).not.toHaveClass(/\bmode-hide\b/);
  });

  test('renderer still honors setDisplayMode over the message bus', async () => {
    // Drive the bus directly from the panel's chrome context — the UI
    // control is gone but the contract (and the renderer's hide mode)
    // remains for programmatic use.
    const sendMode = (mode: 'collapse' | 'hide') =>
      env.panel.evaluate(async (m) => {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId === undefined) throw new Error('no active tab');
        return chrome.tabs.sendMessage(tabId, { t: 'setDisplayMode', v: 1, mode: m });
      }, mode);

    await env.fixture.bringToFront();
    await sendMode('hide');
    await expect(env.fixture.locator('.joblist')).toHaveClass(/\bmode-hide\b/);
    const slivers = env.fixture.locator('.sliver');
    await expect(slivers).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeHidden();
    }

    // Restored items remain visible even in hide mode.
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');
    const r1 = env.fixture.locator('.filt[data-nf-id="r-001"]');
    await expect(r1).toHaveClass(/\brestored\b/);
    await expect(r1).toBeVisible();
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');

    // Back to collapse.
    await sendMode('collapse');
    await expect(env.fixture.locator('.joblist')).not.toHaveClass(/\bmode-hide\b/);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeVisible();
    }
  });
});
