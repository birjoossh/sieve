// 0.4 — "Enable on this site" button reflects the active tab's origin.
//
// Gate from tasks.md:
//   open side panel; button rendered with the active tab's origin.
//
// In Playwright we can't drive Chrome's real side-panel UI, so we load
// panel.html in a regular tab and exercise the same logic the panel runs in
// production: query `{active: true, lastFocusedWindow: true}`, filter to
// http(s) origins. We spin up a one-page localhost HTTP server for the
// content tab so we get a real http:// origin string to assert against.

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..', 'dist');

test.describe('0.4 — enable-site button tracks active tab', () => {
  let context: BrowserContext;
  let userDataDir: string;
  let extId: string;
  let server: Server;
  let fixtureOrigin: string;

  test.beforeAll(async () => {
    // Tiny static server so the content tab has a real http:// origin.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><title>fixture</title><h1>Fixture</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    fixtureOrigin = `http://127.0.0.1:${port}`;

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
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function openPanel(): Promise<Page> {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    return panel;
  }

  test('shows "Enable on <origin>" once a real http(s) tab is active', async () => {
    // Open the fixture tab first so it's a known peer when the panel opens.
    const fixture = await context.newPage();
    await fixture.goto(fixtureOrigin + '/');

    const panel = await openPanel();
    // The panel tab is the active one immediately after open, so its first
    // paint should be the "no enableable site" state (chrome-extension://
    // origins are filtered out).
    await panel.waitForFunction(
      () => document.querySelector('button[data-action="enable-site"]')?.textContent ===
        'No enableable site',
      null,
      { timeout: 5_000 },
    );

    // Bring the fixture tab to front → tabs.onActivated fires in the panel.
    await fixture.bringToFront();

    await panel.waitForFunction(
      (origin) => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-action="enable-site"]',
        );
        return !!btn && !btn.disabled && btn.textContent === `Enable on ${new URL(origin).hostname}`;
      },
      fixtureOrigin,
      { timeout: 5_000 },
    );

    // Sanity: button is enabled now.
    const disabled = await panel.evaluate(
      () => (document.querySelector('button[data-action="enable-site"]') as HTMLButtonElement)
        .disabled,
    );
    expect(disabled).toBe(false);

    await fixture.close();
    await panel.close();
  });

  test('falls back to "No enableable site" for non-http(s) origins', async () => {
    // Only the panel tab is open — its own chrome-extension:// origin must
    // be ignored.
    const panel = await openPanel();

    await panel.waitForFunction(
      () =>
        document.querySelector('button[data-action="enable-site"]')?.textContent ===
        'No enableable site',
      null,
      { timeout: 5_000 },
    );

    const disabled = await panel.evaluate(
      () => (document.querySelector('button[data-action="enable-site"]') as HTMLButtonElement)
        .disabled,
    );
    expect(disabled).toBe(true);

    await panel.close();
  });
});
