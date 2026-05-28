// 1.8 — panel/components/page-status.ts: DISPLAY toggle (collapse | hide)
// wired to `mode-hide` on the item-set container.
//
// Gate from tasks.md:
//   switch to hide → 0 visible `.sliver`; switch back → 5 slivers.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('1.8 — DISPLAY mode toggle', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);

    // Seed with both phrases → 5 filtered cards (3 mandarin + unpaid + no compensation).
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

  test('Hide → 0 visible slivers; Collapse → 5 visible slivers', async () => {
    // Initial mode = collapse; 5 slivers visible.
    const slivers = env.fixture.locator('.sliver');
    await expect(slivers).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeVisible();
    }
    // Joblist starts WITHOUT mode-hide.
    await expect(env.fixture.locator('.joblist')).not.toHaveClass(/\bmode-hide\b/);

    // ── Switch to HIDE ────────────────────────────────────────────────────
    await env.panel.click('.mode-btn[data-mode="hide"]');

    // mode-hide gets applied to the item-set container.
    await expect(env.fixture.locator('.joblist')).toHaveClass(/\bmode-hide\b/);
    // Slivers still in the DOM but display:none → 0 visible.
    await expect(slivers).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeHidden();
    }

    // Panel toggle reflects state.
    await expect(env.panel.locator('.mode-btn[data-mode="hide"]')).toHaveClass(/\bactive\b/);
    await expect(env.panel.locator('.mode-btn[data-mode="hide"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Restored items remain visible even in hide mode — restore card 1 via
    // its HIDDEN row, then assert its wrapper is still visible (the card).
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');
    const r1 = env.fixture.locator('.filt[data-nf-id="r-001"]');
    await expect(r1).toHaveClass(/\brestored\b/);
    // The .filt.restored wrapper is `display: revert` in hide mode CSS:
    // our rule `.mode-hide > .filt:not(.restored) { display: none; }` keeps
    // restored items visible.
    await expect(r1).toBeVisible();
    // Re-hide it for the next assertion.
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');

    // ── Switch back to COLLAPSE ────────────────────────────────────────────
    await env.panel.click('.mode-btn[data-mode="collapse"]');
    await expect(env.fixture.locator('.joblist')).not.toHaveClass(/\bmode-hide\b/);
    for (let i = 0; i < 5; i++) {
      await expect(slivers.nth(i)).toBeVisible();
    }
    await expect(env.panel.locator('.mode-btn[data-mode="collapse"]')).toHaveClass(/\bactive\b/);
  });
});
