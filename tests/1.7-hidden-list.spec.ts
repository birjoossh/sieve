// 1.7 — panel/components/hidden-list.ts: HIDDEN (N) row toggle + restore/hide
// all bulk actions, with in-page state mirroring the panel.
//
// Gate from tasks.md:
//   toggle a row; in-page state matches; toggle restore-all twice → all
//   restored then all re-hidden.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('1.7 — panel hidden-list', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
    // Seed 3 hidden cards (cards 1, 3, 5).
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('per-row restore ⇄ hide mirrors to in-page state', async () => {
    // HIDDEN (3) header.
    await expect(env.panel.locator('#hidden-list .section-h')).toHaveText('Hidden (3)');
    await expect(env.panel.locator('.hidden-row')).toHaveCount(3);

    // Restore card r-001 via the panel row.
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');

    // Panel row flips to state-restored + label changes.
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-001"]'),
    ).toHaveClass(/\bstate-restored\b/);
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-001"] .row-toggle'),
    ).toHaveText('hide');

    // In-page: r-001's wrapper is now .restored → card visible, sliver hidden.
    const wrapper001 = env.fixture.locator('.filt[data-nf-id="r-001"]');
    await expect(wrapper001).toHaveClass(/\brestored\b/);
    await expect(wrapper001.locator('> .job')).toBeVisible();
    await expect(wrapper001.locator('> .sliver')).toBeHidden();

    // Toggle back via the panel.
    await env.panel.click('.hidden-row[data-item-id="r-001"] .row-toggle');
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-001"]'),
    ).not.toHaveClass(/\bstate-restored\b/);
    await expect(wrapper001).not.toHaveClass(/\brestored\b/);
    await expect(wrapper001.locator('> .sliver')).toBeVisible();

    // Reverse direction: click the IN-PAGE sliver, panel row must follow.
    // (BUILD_PLAN's Slice-1 demo gate: "panel HIDDEN row also toggles.")
    await env.fixture.locator('.filt[data-nf-id="r-003"] > .sliver').click();
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-003"]'),
    ).toHaveClass(/\bstate-restored\b/);
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-003"] .row-toggle'),
    ).toHaveText('hide');
    // And the ↺ re-hide marker round-trips back into the panel too.
    await env.fixture.locator('.filt[data-nf-id="r-003"] > .rehide').click();
    await expect(
      env.panel.locator('.hidden-row[data-item-id="r-003"]'),
    ).not.toHaveClass(/\bstate-restored\b/);
  });

  test('restore-all ⇄ hide-all twice → all restored then all re-hidden', async () => {
    // Initially: 3 filtered, 0 restored.
    await expect(
      env.panel.locator('.hidden-row.state-restored'),
    ).toHaveCount(0);

    // RESTORE ALL.
    await env.panel.click('button[data-action="restore-all"]');

    await expect(env.panel.locator('.hidden-row.state-restored')).toHaveCount(3);
    // In-page: all 3 wrappers carry `.restored`.
    await expect(env.fixture.locator('.filt.restored')).toHaveCount(3);
    // Restore-all is now disabled, Hide-all enabled.
    await expect(
      env.panel.locator('button[data-action="restore-all"]'),
    ).toBeDisabled();
    await expect(
      env.panel.locator('button[data-action="hide-all"]'),
    ).toBeEnabled();

    // HIDE ALL — round-trip back.
    await env.panel.click('button[data-action="hide-all"]');
    await expect(env.panel.locator('.hidden-row.state-restored')).toHaveCount(0);
    await expect(env.fixture.locator('.filt.restored')).toHaveCount(0);
    await expect(
      env.panel.locator('button[data-action="restore-all"]'),
    ).toBeEnabled();
    await expect(
      env.panel.locator('button[data-action="hide-all"]'),
    ).toBeDisabled();

    // Second round: RESTORE ALL again, then HIDE ALL.
    await env.panel.click('button[data-action="restore-all"]');
    await expect(env.fixture.locator('.filt.restored')).toHaveCount(3);
    await env.panel.click('button[data-action="hide-all"]');
    await expect(env.fixture.locator('.filt.restored')).toHaveCount(0);
  });
});
