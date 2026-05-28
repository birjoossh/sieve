// 4.4 — Panel: structured value editor (slider + units) for numeric predicates.
//
// Gate from tasks.md:
//   "drag the slider → filter re-evaluates with new value."
//
// Full-stack: real extension, fixture over http, panel drives content.
// We enable the numeric filter, drag the slider to two thresholds, and
// assert that the in-page sliver count tracks the value. The engine
// reads the comp field (Slice 4.1 numeric arm, lower-bound semantics via
// parseFirstNumber: "$180k–$220k" → 180).
//
// rolecast.html comp lower bounds (engine inputs):
//   r-001 180  r-002 160  r-003 130  r-004 200  r-005 210
//   r-006 170  r-007   0  r-008 140  r-009 null (stipend → skipped)
//   r-010 185
//
// With exclude + lessThan 150: cards 3, 7, 8 → 3 slivers.
// With exclude + lessThan 200: cards 1, 2, 3, 6, 7, 8, 10 → 7 slivers.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

test.describe('4.4 — numeric slider editor', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('toggle on → drag slider → engine re-evaluates per slider value', async () => {
    // Editor renders; numeric filter disabled by default → 0 slivers.
    await expect(env.panel.locator('input[data-input="numeric-enabled"]')).toHaveCount(1);
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);

    // Set the slider to 150 BEFORE enabling — the slider widget is in
    // the DOM and `fill` works on a disabled-but-not-disabled-attr range
    // input. We then flip the enable checkbox to push the filter.
    await env.panel.locator('input[data-input="numeric-value"]').fill('150');
    await env.panel.locator('input[data-input="numeric-enabled"]').check();

    // Op defaults to lessThan → 3 cards under 150k get filtered.
    await expect(env.panel.locator('[data-role="numeric-readout"]')).toHaveText('150 k$');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Drag the slider higher → more cards drop out. fill() on a
    // type=range fires 'input', which is what our editor listens for.
    await env.panel.locator('input[data-input="numeric-value"]').fill('200');
    await expect(env.panel.locator('[data-role="numeric-readout"]')).toHaveText('200 k$');
    await expect(env.fixture.locator('.sliver')).toHaveCount(7);

    // Flip the op to greaterThan at the same value → inverts the
    // partition. Strict greater, so r-004 (200) and r-010 (185) pass;
    // only r-005 (210) is strictly > 200 → 1 sliver.
    await env.panel.locator('select[data-input="numeric-op"]').selectOption('greaterThan');
    await expect(env.fixture.locator('.sliver')).toHaveCount(1);

    // Disable → numeric filter dropped from the pushed list → 0 slivers.
    await env.panel.locator('input[data-input="numeric-enabled"]').uncheck();
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });

  test('numeric filter ANDs with the phrase filter (4.3 composition)', async () => {
    // Re-add a phrase: "Mandarin" filters 3 cards (1, 3, 5) by snippet.
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Add numeric: lessThan 150 → filters cards 3, 7, 8 by comp.
    // Union (AND of two exclude filters → either side excludes): cards
    // 1, 3, 5, 7, 8 → 5 slivers. Re-pin the op explicitly — the panel
    // state survives the previous test's run and may still be set to
    // greaterThan, which would give a different (7-sliver) result.
    await env.panel.locator('select[data-input="numeric-op"]').selectOption('lessThan');
    await env.panel.locator('input[data-input="numeric-value"]').fill('150');
    await env.panel.locator('input[data-input="numeric-enabled"]').check();
    await expect(env.fixture.locator('.sliver')).toHaveCount(5);

    // Cleanup so the suite is order-independent.
    await env.panel.locator('input[data-input="numeric-enabled"]').uncheck();
    await env.panel.click('.chip[data-phrase="Mandarin"] .chip-remove');
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});
