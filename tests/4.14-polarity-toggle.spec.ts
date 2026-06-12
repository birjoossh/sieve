// 4.14 — panel/components/filter-list.ts: per-filter-set polarity toggle.
//
// Three-way segmented control above the phrase chips:
//   Hide matches (exclude, default) | Show only matches (keep) | Off.
//
// Full-stack: real extension, rolecast fixture (10 cards, 3 match
// "mandatory Mandarin"). The engine has supported keep-polarity since 4.2 —
// this spec locks in the panel wiring: buildFilters maps the toggle onto the
// pushed phrase filter ('keep' flips polarity, 'off' omits the filter while
// the chips stay in the panel).

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.14 — polarity toggle (hide ⇄ show-only ⇄ off)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('default exclude hides 3; keep hides the inverse 7; off hides 0 but keeps chips', async () => {
    const polarityBtn = (p: string) =>
      env.panel.locator(`[data-role="filter-polarity"] [data-polarity="${p}"]`);

    // Control renders with "Hide matches" pressed by default.
    await expect(env.panel.locator('[data-role="filter-polarity"]')).toHaveCount(1);
    await expect(polarityBtn('exclude')).toHaveAttribute('aria-pressed', 'true');
    await expect(polarityBtn('keep')).toHaveAttribute('aria-pressed', 'false');
    await expect(polarityBtn('off')).toHaveAttribute('aria-pressed', 'false');

    // Seed the phrase — default polarity hides the 3 matching cards.
    await env.panel.fill('input[data-input="phrase"]', 'mandatory Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // ── Show only matches ──────────────────────────────────────────────
    await polarityBtn('keep').click();
    await expect(polarityBtn('keep')).toHaveAttribute('aria-pressed', 'true');
    await expect(polarityBtn('keep')).toHaveClass(/\bactive\b/);
    // Inverse of 3-of-10: the 7 non-matching cards are hidden.
    await expect(env.fixture.locator('.sliver')).toHaveCount(7);

    // ── Off ────────────────────────────────────────────────────────────
    await polarityBtn('off').click();
    await expect(polarityBtn('off')).toHaveAttribute('aria-pressed', 'true');
    // Nothing hidden, but the chip survives — off is a pause, not a reset.
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
    await expect(env.panel.locator('.chip[data-phrase="mandatory Mandarin"]')).toHaveCount(1);

    // ── Back to Hide matches ───────────────────────────────────────────
    await polarityBtn('exclude').click();
    await expect(polarityBtn('exclude')).toHaveAttribute('aria-pressed', 'true');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);
  });
});
