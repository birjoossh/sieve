// 1.2 — fixtures/rolecast.html loads cleanly headless.
//
// Gate from tasks.md: "fixture loads cleanly headless."
// Bound check: 10 .job items + the 5/5 match split that Slice 1's later
// gates depend on (so a stray edit to the fixture breaks here, not at 1.3).

import { test, expect, chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'rolecast.html')).href;

test.describe('1.2 — rolecast fixture', () => {
  test('loads with 10 jobs, 5 matching the planned Slice-1 phrases', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`);
    });

    await page.goto(FIXTURE);

    expect(await page.locator('.joblist > .job').count()).toBe(10);

    // Match plan: filter A "mandatory Mandarin" hits 1, 3, 5;
    // filter B "unpaid"/"no compensation" hits 7, 9 → 5 / 5 split.
    const mandarinCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.joblist > .job .snippet')).filter((el) =>
        el.textContent?.toLowerCase().includes('mandatory mandarin'),
      ).length;
    });
    expect(mandarinCount).toBe(3);

    const unpaidCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.joblist > .job .snippet')).filter((el) => {
        const t = el.textContent?.toLowerCase() ?? '';
        return t.includes('unpaid') || t.includes('no compensation');
      }).length;
    });
    expect(unpaidCount).toBe(2);

    expect(consoleErrors).toEqual([]);
    await browser.close();
  });
});
