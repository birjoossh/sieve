// 0.1 — Project bootstrap smoke check.
//
// Gate from tasks.md:
//   `npm run build` → `dist/` exists; load as unpacked in a Chromium context
//   → extension installs without errors.
//
// We rely on the build having already happened (`npm run build` writes dist/),
// then launch a persistent Chromium context with the unpacked extension and
// assert the service worker comes online without console errors.

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_DIR = resolve(__dirname, '..', 'dist');

test.describe('0.1 — project bootstrap', () => {
  test('dist/ exists with the expected bundles + manifest', () => {
    expect(existsSync(EXT_DIR)).toBe(true);
    for (const f of ['manifest.json', 'background.js', 'content.js', 'panel.js', 'panel.html']) {
      expect(existsSync(join(EXT_DIR, f)), `missing dist/${f}`).toBe(true);
    }
  });

  test('extension loads in a Chromium persistent context with a live service worker', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'nf-ext-'));
    let context: BrowserContext | undefined;
    const consoleErrors: string[] = [];

    try {
      // `channel: 'chromium'` uses the full Chromium build (not the headless_shell
       // binary), which is the only headless mode that actually loads MV3 extensions.
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: 'chromium',
        args: [
          `--disable-extensions-except=${EXT_DIR}`,
          `--load-extension=${EXT_DIR}`,
          '--no-sandbox',
        ],
      });

      context.on('weberror', (err) => consoleErrors.push(`weberror: ${err.error().message}`));

      // Service worker may take a moment to register; poll up to the test timeout.
      let sw = context.serviceWorkers()[0];
      if (!sw) {
        sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
      }
      expect(sw, 'background service worker should be registered').toBeTruthy();
      expect(sw.url(), 'SW URL should point at background.js').toMatch(/background\.js$/);

      // No console errors propagated from the SW or any open page during install.
      expect(consoleErrors).toEqual([]);
    } finally {
      await context?.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
