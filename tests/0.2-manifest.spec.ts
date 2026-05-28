// 0.2 — Manifest permission model.
//
// Gate from tasks.md:
//   install prompt asks for **none of `<all_urls>`** (clean install).
//
// Translation for a Playwright runtime check: load the extension; from the SW,
// assert `chrome.permissions.getAll().origins` is empty (nothing host-related
// auto-granted) AND the live manifest declares `<all_urls>` under
// `optional_host_permissions`, never `host_permissions`. Together those mean
// the Web Store install flow would not show the broad-host prompt.

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..', 'dist');

test.describe('0.2 — manifest declares <all_urls> as optional, not required', () => {
  let context: BrowserContext;
  let userDataDir: string;

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
  });

  test.afterAll(async () => {
    await context?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('no host origins are auto-granted at install', async () => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    const perms = await sw.evaluate(() => chrome.permissions.getAll());

    expect(perms.origins ?? [], 'no broad host should be auto-granted').toEqual([]);
    // API permissions we did request — sanity-check they made it through.
    expect(perms.permissions).toEqual(
      expect.arrayContaining(['sidePanel', 'scripting', 'alarms', 'storage']),
    );
  });

  test('manifest declares <all_urls> under optional_host_permissions, not host_permissions', async () => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());

    expect(manifest.optional_host_permissions ?? []).toContain('<all_urls>');
    expect(manifest.host_permissions ?? []).not.toContain('<all_urls>');
    // Side panel wired through manifest so Chrome's side-panel UI exposes it.
    expect((manifest as chrome.runtime.Manifest).side_panel?.default_path).toBe('panel.html');
  });
});
