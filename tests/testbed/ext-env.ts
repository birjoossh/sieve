// tests/testbed/ext-env.ts — shared setup for tests that need the real
// extension loaded, a fixture served over http, and the panel open.
//
// Reuses the 0.6 trick: copy dist/ → tmp, bake <all_urls> in so the
// permission prompt doesn't hang in headless. Production manifest stays
// untouched.
//
// One ExtEnv per spec — `setup()` returns the env handle and a teardown
// helper. Each fixture is served from a fresh ephemeral http server so
// origin is unique-per-spec and registrations don't collide.

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_DIST = resolve(__dirname, '..', '..', 'dist');
const FIXTURE_DIR = resolve(__dirname, '..', '..', 'fixtures');

export interface ExtEnv {
  context: BrowserContext;
  extId: string;
  fixtureOrigin: string;
  fixtureUrl: string;
  panel: Page;
  fixture: Page;
  /** Tear down server + context + tmp dirs. */
  teardown: () => Promise<void>;
}

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

/** Serves any file in fixtures/ verbatim. The fixture path becomes the URL
 *  path — e.g. `/rolecast.html` → `fixtures/rolecast.html`. */
function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolveOuter) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      // Default to rolecast for `/` so callers can reuse the origin root.
      const pathname = url.pathname === '/' ? '/rolecast.html' : url.pathname;
      const filePath = resolve(FIXTURE_DIR, '.' + pathname);
      if (!filePath.startsWith(FIXTURE_DIR) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = pathname.split('.').pop() ?? '';
      const ctype =
        ext === 'html'
          ? 'text/html; charset=utf-8'
          : ext === 'json'
            ? 'application/json'
            : 'text/plain';
      res.writeHead(200, { 'Content-Type': ctype });
      const stream = createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
    server.on('clientError', () => undefined);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveOuter({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

export interface SetupExtEnvOptions {
  /** Initial fixture path served from the test server. Defaults to
   *  `/rolecast.html` to match existing specs. */
  fixturePath?: string;
  /** Optional hostname to alias to 127.0.0.1 via Chrome's
   *  `--host-resolver-rules`. Use this when a spec needs `location.hostname`
   *  to look like a real site so a stub's host gate fires (e.g.
   *  `linkedin.local` makes `pickStubSchema()` match the LinkedIn rule). */
  hostname?: string;
}

export async function setupExtEnv(opts: SetupExtEnvOptions = {}): Promise<ExtEnv> {
  const extDir = await buildTestExtension();
  const userDataDir = await mkdtemp(join(tmpdir(), 'nf-ext-'));

  const { server, origin } = await startFixtureServer();
  const port = new URL(origin).port;

  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-sandbox',
  ];
  // host-resolver-rules lets us pretend the local fixture server is hosted
  // at a real-looking domain; the stub host-includes check (`linkedin.`)
  // depends on `location.hostname` and we can't rewrite that any other way.
  if (opts.hostname) {
    args.push(`--host-resolver-rules=MAP ${opts.hostname} 127.0.0.1`);
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args,
  });
  const sw =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // Open fixture first so the active tab is enableable when the panel opens.
  const fixturePath = opts.fixturePath ?? '/rolecast.html';
  const fixtureOrigin = opts.hostname
    ? `http://${opts.hostname}:${port}`
    : origin;
  const fixtureUrl = `${fixtureOrigin}${fixturePath}`;
  const fixture = await context.newPage();
  await fixture.goto(fixtureUrl);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  // Re-focus the fixture so chrome.tabs.query({active,lastFocusedWindow})
  // resolves to it in the panel.
  await fixture.bringToFront();

  const teardown = async (): Promise<void> => {
    await context.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  };

  return { context, extId, fixtureOrigin, fixtureUrl, panel, fixture, teardown };
}

/** Click the panel's enable button + wait for the content script to come up
 *  on the fixture. Returns once getState() succeeds (i.e. the page is
 *  detected). */
export async function enableAndWaitForContent(env: ExtEnv): Promise<void> {
  await env.fixture.bringToFront();
  // Wait for the panel to render the enable button with the fixture origin.
  await env.panel.waitForFunction(
    (origin) => {
      const btn = document.querySelector<HTMLButtonElement>(
        'button[data-action="enable-site"]',
      );
      return btn?.textContent === `Enable on ${new URL(origin).hostname}`;
    },
    env.fixtureOrigin,
    { timeout: 5_000 },
  );
  await env.panel.click('button[data-action="enable-site"]');
  // After enable, the content script needs the fixture tab to reload to
  // inject. We trigger the reload manually (the production UX would tell
  // the user to refresh).
  await env.fixture.reload();
  // Wait for content's pageDetected push to land in the panel — surfaces
  // as a non-empty hidden-list section header.
  await env.panel.waitForFunction(
    () => {
      const h = document.querySelector('#page-status .section-meta');
      return (h?.textContent ?? '').includes('list');
    },
    undefined,
    { timeout: 5_000 },
  );
  // Make sure the panel is showing the fixture's origin still.
  await env.fixture.bringToFront();
  await env.panel.waitForFunction(
    () => {
      // The mode toggle only renders when schema is non-null.
      return document.querySelector('[data-role="display-mode"]') !== null;
    },
    undefined,
    { timeout: 5_000 },
  );
}
