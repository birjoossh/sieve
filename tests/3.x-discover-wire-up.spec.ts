// Slice-3 production wire-up: panel → content → SW → getOrDiscover.
//
// We can't hit a real LLM in tests. To exercise the wire-up end-to-end
// we pre-seed the SW's schema cache (chrome.storage.local key
// `nf:schema:<fp>`) for the fingerprint the discover() pipeline will
// compute on the fixture. Cache hit returns the seeded schema, no LLM
// call, and the content script mounts the engine + renderer.
//
// The fixture has no .joblist (so pickStubSchema returns null) but
// has a clear `.feed > .card` repeated structure that detect() picks
// up — same gate the YouTube path runs against.

import { test, expect } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('Slice-3 wire-up — content auto-discovers via SW round-trip', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('navigate to no-stub fixture → SW cache hit → engine mounts + filter works', async () => {
    // Pre-seed the schema cache so the SW returns cache hit instead
    // of calling the LLM. The fingerprint must match what
    // fingerprintItemSet() computes against the fixture's .feed
    // container — read it back from the testbed once.
    await env.fixture.goto(`${env.fixtureOrigin}/no-stub-list.html`);

    // Compute the fingerprint via a temporary testbed script tag.
    // We inject the testbed bundle to expose __nf and compute
    // fingerprintItemSet() against the fixture's .feed container.
    await env.fixture.addScriptTag({ path: TESTBED });
    const fp = await env.fixture.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const container = document.querySelector('.feed');
      return container ? nf.fingerprintItemSet(container) : null;
    });
    expect(fp).not.toBeNull();

    // Seed the schema cache in storage.local. The SW path uses
    // chromeStorageSchemaCache which reads `nf:schema:<fp>`.
    await env.panel.evaluate(
      async ([key, schema]) => {
        await chrome.storage.local.set({ [key as string]: schema });
      },
      [
        `nf:schema:${fp}`,
        {
          fingerprint: fp,
          layout: 'list',
          itemSetSelector: '.feed',
          itemSelector: '.feed > .card',
          fields: {
            title: { kind: 'text', selector: 'h2' },
            snippet: { kind: 'text', selector: 'p' },
          },
          source: 'llm',
          discoveredAt: 0,
        },
      ],
    );
    // Ensure an LLM key is set so the SW handler doesn't short-
    // circuit on no-api-key. Cache hit means it won't actually be
    // used, but the SW's preflight requires it present.
    await env.panel.evaluate(async () => {
      await chrome.storage.local.set({
        'nf:llm-settings': { provider: 'anthropic', apiKey: 'sk-test' },
      });
    });

    // Reload the fixture so content runs init() against the seeded
    // schema cache.
    await env.fixture.reload();

    // pageDetected should fire — wait for the panel's display-mode
    // toggle to render (which only mounts when schema !== null).
    await env.panel.waitForFunction(
      () => document.querySelector('[data-role="display-mode"]') !== null,
      undefined,
      { timeout: 10_000 },
    );

    // Add a "Mandarin" phrase filter via the panel → 2 slivers in
    // the fixture (cards 2 and 4).
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');
    await expect(env.fixture.locator('.sliver')).toHaveCount(2);
  });
});
