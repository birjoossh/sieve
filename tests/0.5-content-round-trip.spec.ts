// 0.5 — Content script round-trips a message with the SW.
//
// Gate from tasks.md:
//   on an enabled fixture page, content logs the SW-roundtripped value to the
//   test-captured console.
//
// We can't realistically "enable" a real http(s) origin in headless Chromium
// — `chrome.permissions.request` hangs there (see memory.md). Since 0.5 is
// about the wire (`content sends ping → SW returns pong → content logs it`),
// we host content.js inside the panel page (a chrome-extension:// URL, so
// chrome.runtime is already wired) and inject it via a synthetic <script>
// tag. 0.6 owns the real per-domain auto-inject gate; that's where the
// permission-grant problem gets solved properly.
//
// Capture-order matters: the console listener is attached *before* the script
// tag is appended, otherwise the IIFE fires and logs before we're listening.

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..', 'dist');

const LOG_PREFIX = '[negative-filter] SW round-trip';

test.describe('0.5 — content script round-trips with SW', () => {
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

  test('content.js logs the pong reply on load', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/panel.html`);

    // Attach the listener *before* injecting — content.js is IIFE and fires
    // on parse, so any logs emitted before this point are lost.
    const seen = page.waitForEvent('console', {
      predicate: (m) => m.type() === 'log' && m.text().includes(LOG_PREFIX),
      timeout: 5_000,
    });

    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'content.js';
      document.head.appendChild(s);
    });

    const msg = await seen;
    // msg.args() preserves the structured object the page logged, instead of
    // the DevTools-rendered string ("{t: pong, v: 1}") that msg.text() returns.
    const args = msg.args();
    expect(args.length).toBeGreaterThanOrEqual(2);
    const payload = await args[1]!.jsonValue();
    expect(payload).toEqual({ t: 'pong', v: 1 });

    await page.close();
  });

  test('round-trip surfaces a typed pong (not raw stringified runtime reply)', async () => {
    // Defensive: the LOG_PREFIX matcher above could in principle fire on an
    // error path too. Pin that we're seeing the success branch — and that the
    // logged object has the shape we expect from the validated wire.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/panel.html`);

    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (!text.includes('[negative-filter]')) return;
      // The Slice-3 production wire-up runs `tryDiscover()` whenever
      // the stub schema doesn't match the page. On panel.html (this
      // injection target) with no API key configured, the LLM
      // round-trip surfaces a "no-api-key" error which is logged here.
      // That's a different contract from 0.5's SW round-trip path —
      // ignore it. Anything else that looks like an error stays.
      if (text.includes('discover failed')) return;
      errors.push(text);
    });

    const seen = page.waitForEvent('console', {
      predicate: (m) => m.type() === 'log' && m.text().includes(LOG_PREFIX),
      timeout: 5_000,
    });

    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = 'content.js';
      document.head.appendChild(s);
    });

    await seen;
    // Give any error-path log a tick to land.
    await page.waitForTimeout(50);
    expect(errors).toEqual([]);

    await page.close();
  });
});
