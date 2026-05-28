// 1.5 — `↺ re-hide` marker on `.filt.restored`; click swaps sliver ⇄ card.
//
// Gate from tasks.md:
//   click a sliver → marker visible + card visible;
//   click marker → sliver visible + card hidden again.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'rolecast.html')).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('1.5 — re-hide toggle', () => {
  test('sliver click reveals card + marker; marker click re-hides', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const filters = [
        nf.makeFilter({
          id: 'f-mandarin',
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['mandatory Mandarin'] },
        }),
      ];
      nf.mountRenderer(filters);
    });

    // Pick r-001 (the first filtered card) as the test subject.
    const wrapper = page.locator('.filt[data-nf-id="r-001"]');
    const card = wrapper.locator('> .job');
    const sliver = wrapper.locator('> .sliver');
    const rehide = wrapper.locator('> .rehide');

    // Initial state: card hidden, sliver visible, rehide hidden.
    await expect(card).toBeHidden();
    await expect(sliver).toBeVisible();
    await expect(rehide).toBeHidden();

    // ── CLICK SLIVER → restore ─────────────────────────────────────────────
    await sliver.click();
    await expect(wrapper).toHaveClass(/\brestored\b/);
    await expect(card).toBeVisible();
    await expect(rehide).toBeVisible();
    await expect(sliver).toBeHidden();

    // The reported summary should now say `restored` for this item.
    const restoredState = await page.evaluate(() => {
      const r = (window as unknown as { __nfRenderer: { summaries(): Array<{ id: string; state: string }> } }).__nfRenderer;
      return r.summaries().find((s) => s.id === 'r-001')?.state;
    });
    expect(restoredState).toBe('restored');

    // ── CLICK MARKER → re-hide ─────────────────────────────────────────────
    await rehide.click();
    await expect(wrapper).not.toHaveClass(/\brestored\b/);
    await expect(card).toBeHidden();
    await expect(rehide).toBeHidden();
    await expect(sliver).toBeVisible();

    const reHiddenState = await page.evaluate(() => {
      const r = (window as unknown as { __nfRenderer: { summaries(): Array<{ id: string; state: string }> } }).__nfRenderer;
      return r.summaries().find((s) => s.id === 'r-001')?.state;
    });
    expect(reHiddenState).toBe('filtered');

    // Other filtered cards must be unaffected by the toggle.
    const otherWrapper = page.locator('.filt[data-nf-id="r-003"]');
    await expect(otherWrapper).not.toHaveClass(/\brestored\b/);
    await expect(otherWrapper.locator('> .job')).toBeHidden();
    await expect(otherWrapper.locator('> .sliver')).toBeVisible();

    await browser.close();
  });
});
