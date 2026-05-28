// 0.6 — Per-domain enable flow.
//
// Gate from tasks.md:
//   click "Enable on rolecast.html"; reload tab; content script auto-injects
//   without further prompts. Disable → content script no longer runs.
//
// Permission-grant prompts hang in headless Chromium (see memory.md), so we
// build a test variant of the extension where `<all_urls>` is required
// instead of optional. With the perm baked, `chrome.permissions.request` for
// any matching origin resolves with granted=true immediately — no prompt to
// hang on — and the rest of the production code path runs unmodified
// (panel click → request → sendToSw(enableDomain) → SW registers content
// scripts → reload → inject).
//
// Production manifest is unchanged. The "user actually clicks Allow in the
// real prompt" sub-step stays manual-only.

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_DIST = resolve(__dirname, '..', 'dist');
const LOG_PREFIX = '[negative-filter] SW round-trip';

/** Copy production dist → tmp, then promote `<all_urls>` from optional to
 *  required so the permission prompt doesn't fire. Returns the tmp dir
 *  path. */
async function buildTestExtension(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nf-ext-test-'));
  await cp(PROD_DIST, dir, { recursive: true });

  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;

  manifest['host_permissions'] = ['<all_urls>'];
  delete manifest['optional_host_permissions'];

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

test.describe('0.6 — enable/disable a domain end-to-end', () => {
  let context: BrowserContext;
  let userDataDir: string;
  let extId: string;
  let extDir: string;
  let server: Server;
  let fixtureOrigin: string;

  test.beforeAll(async () => {
    extDir = await buildTestExtension();

    // Tiny static server so we have a real http:// origin to register
    // content scripts against. Every request returns the same HTML —
    // content of the page doesn't matter, only that it parses and that
    // our content script runs at document_idle.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><title>fixture</title><h1>Fixture</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    fixtureOrigin = `http://127.0.0.1:${port}`;

    userDataDir = await mkdtemp(join(tmpdir(), 'nf-ext-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-sandbox',
      ],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function openPanel(): Promise<Page> {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    return panel;
  }

  /** Wait until the enable-site button reflects the expected enabled-state
   *  for the given origin. Returns the button's text content. */
  async function waitForButtonState(
    panel: Page,
    origin: string,
    enabled: boolean,
  ): Promise<string> {
    await panel.waitForFunction(
      ({ origin, enabled }) => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-action="enable-site"]',
        );
        if (!btn) return false;
        const expectedLabel = enabled ? `Disable on ${origin}` : `Enable on ${origin}`;
        return btn.textContent === expectedLabel && btn.dataset.enabled === String(enabled);
      },
      { origin, enabled },
      { timeout: 5_000 },
    );
    return (await panel.evaluate(
      () =>
        (document.querySelector('button[data-action="enable-site"]') as HTMLButtonElement)
          .textContent,
    )) ?? '';
  }

  test('click Enable → content script auto-injects on reload; click Disable → no longer runs', async () => {
    // Stand up the fixture tab first so the panel can see its origin.
    const fixture = await context.newPage();
    await fixture.goto(fixtureOrigin + '/');

    // Open panel; fixture must be the active tab (lastFocusedWindow) for
    // the panel to surface the right origin.
    const panel = await openPanel();
    await fixture.bringToFront();
    await waitForButtonState(panel, fixtureOrigin, /* enabled */ false);

    // ── ENABLE PATH ──────────────────────────────────────────────────────
    // The click runs in the user-gesture context, drives
    // chrome.permissions.request (resolves immediately because <all_urls>
    // is baked in the test build), then sendToSw(enableDomain).
    await panel.click('button[data-action="enable-site"]');
    await waitForButtonState(panel, fixtureOrigin, /* enabled */ true);

    // Reload the fixture tab and assert the content script auto-injects.
    // Listener attached BEFORE reload so the IIFE's log isn't lost.
    const enableSeen = fixture.waitForEvent('console', {
      predicate: (m) => m.type() === 'log' && m.text().includes(LOG_PREFIX),
      timeout: 5_000,
    });
    await fixture.reload();
    const enableMsg = await enableSeen;
    const enableArgs = enableMsg.args();
    expect(enableArgs.length).toBeGreaterThanOrEqual(2);
    expect(await enableArgs[1]!.jsonValue()).toEqual({ t: 'pong', v: 1 });

    // ── DISABLE PATH ─────────────────────────────────────────────────────
    // Keep fixture in front: bringing the panel to front would make
    // chrome.tabs.query({active,lastFocusedWindow}) return the panel tab,
    // whose chrome-extension:// origin is filtered out and the button
    // would switch to "No enableable site". `page.click()` doesn't need
    // the page to be focused — clicks target the page object directly.
    await panel.click('button[data-action="enable-site"]');
    await waitForButtonState(panel, fixtureOrigin, /* enabled */ false);

    // Reload again and assert NO content-script log lands within a bounded
    // window. We capture all matching messages, then fail if any arrive.
    const stragglers: string[] = [];
    const onConsole = (m: import('@playwright/test').ConsoleMessage) => {
      if (m.text().includes(LOG_PREFIX)) stragglers.push(m.text());
    };
    fixture.on('console', onConsole);
    await fixture.reload();
    // 1 s is more than enough for an injected script at document_idle —
    // production timing would be sub-100ms on this fixture.
    await fixture.waitForTimeout(1_000);
    fixture.off('console', onConsole);
    expect(stragglers, 'content script should not run after disable').toEqual([]);

    await fixture.close();
    await panel.close();
  });
});
