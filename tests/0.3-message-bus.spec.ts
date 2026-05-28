// 0.3 — Typed message bus.
//
// Gate from tasks.md:
//   panel sends `{t:'ping', v:1}` → SW echoes `{t:'pong', v:1}`.
//
// We drive the gate by loading the panel HTML as a normal extension page
// (`chrome-extension://<id>/panel.html`) so it shares the extension's
// chrome.runtime channel with the SW, then call sendMessage from page context.

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..', 'dist');

test.describe('0.3 — typed message bus (ping → pong)', () => {
  let context: BrowserContext;
  let userDataDir: string;
  let extId: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'nf-ext-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-sandbox',
      ],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('panel page round-trips ping → pong with v:1', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/panel.html`);

    const reply = await page.evaluate(() =>
      chrome.runtime.sendMessage({ t: 'ping', v: 1 }),
    );

    expect(reply).toEqual({ t: 'pong', v: 1 });
    await page.close();
  });

  test('malformed messages are ignored (no reply, no throw)', async () => {
    // Defensive check: the bus rejects unknown variants / wrong version so the
    // sender doesn't get a spurious "pong" or crash the channel.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/panel.html`);

    // Wrong version.
    const wrongV = await page.evaluate(() =>
      chrome.runtime.sendMessage({ t: 'ping', v: 999 }),
    );
    expect(wrongV).toBeUndefined();

    // Unknown discriminator.
    const wrongT = await page.evaluate(() =>
      chrome.runtime.sendMessage({ t: 'nope', v: 1 }),
    );
    expect(wrongT).toBeUndefined();

    await page.close();
  });
});
