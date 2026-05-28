// 4.8 — LLM phrasing suggestions (user-initiated; ✦ button → mock provider).
//
// Gate from tasks.md:
//   "click suggest on a phrase filter → suggestions returned and added
//    as chips on accept."
//
// Two layers:
//   (a) Engine — suggestPhrases parses the provider response (deduped vs
//       existing phrases). Pure testbed call with mock fetcher.
//   (b) Panel UI — set a panel-context fetcher override, click the ✦
//       button, suggestions render as pills with Accept buttons. Click
//       Accept → suggestion moves to chips; engine re-evaluates.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

test.describe('4.8 — phrase suggestions (engine layer)', () => {
  test('suggestPhrases parses provider response + dedupes vs existing', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const fetcher = async () =>
          new Response(
            JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    // includes a dupe of an existing phrase + an empty
                    // string + an over-long string — all should be
                    // dropped by suggestPhrases.
                    suggestions: ['Mandarin', 'unpaid', '', 'a'.repeat(200), 'volunteer'],
                  }),
                },
              ],
            }),
            { status: 200 },
          );
        return await nf.suggestPhrases({
          provider: 'anthropic',
          apiKey: 'sk-test',
          existing: ['Mandarin'],
          intent: 'phrases to add to a negative filter',
          fetcher,
        });
      });
      expect(result).toEqual(['unpaid', 'volunteer']);
    } finally {
      await browser.close();
    }
  });

  test('malformed suggestions response throws SchemaParseError', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');
      await page.addScriptTag({ path: TESTBED });

      const caught = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const fetcher = async () =>
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: JSON.stringify({ wrong_key: [] }) }],
            }),
            { status: 200 },
          );
        try {
          await nf.suggestPhrases({
            provider: 'anthropic',
            apiKey: 'sk-test',
            existing: [],
            intent: 'x',
            fetcher,
          });
          return null;
        } catch (err) {
          return err instanceof nf.SchemaParseError ? err.name : null;
        }
      });
      expect(caught).toBe('SchemaParseError');
    } finally {
      await browser.close();
    }
  });
});

test.describe('4.8 — phrase suggestions (UI layer)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
    // Persist an LLM key so handleSuggest doesn't short-circuit on
    // "no provider key configured."
    await env.panel.evaluate(async () => {
      await chrome.storage.local.set({
        'nf:llm-settings': { provider: 'anthropic', apiKey: 'sk-test-key' },
      });
    });
    await env.panel.reload();
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('click ✦ → suggestions render as pills → Accept adds chip + engine re-evaluates', async () => {
    // Install the panel-context fetcher override. The handler reads
    // (globalThis as any).__nfFetcher first.
    await env.panel.evaluate(() => {
      (window as unknown as { __nfFetcher: typeof fetch }).__nfFetcher =
        async () =>
          new Response(
            JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    suggestions: ['Mandarin', 'unpaid', 'volunteer'],
                  }),
                },
              ],
            }),
            { status: 200 },
          );
    });

    // Initial state: 0 slivers, 0 chips, no suggest list.
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
    await expect(env.panel.locator('.chip')).toHaveCount(0);
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(0);

    // Click ✦ → suggestions populate.
    await env.panel.click('button[data-action="suggest-phrases"]');
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(1);
    await expect(env.panel.locator('.suggest-pill')).toHaveCount(3);

    // Accept the "Mandarin" suggestion → it moves to chips, the pill
    // disappears, and the engine re-evaluates (3 Mandarin cards).
    await env.panel.click('button[data-action="accept-suggestion"][data-suggestion="Mandarin"]');
    await expect(env.panel.locator('.chip[data-phrase="Mandarin"]')).toHaveCount(1);
    await expect(env.panel.locator('.suggest-pill[data-suggestion="Mandarin"]')).toHaveCount(0);
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Dismiss the rest.
    await env.panel.click('button[data-action="dismiss-suggestions"]');
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(0);

    // Cleanup for any follow-on test.
    await env.panel.click('.chip[data-phrase="Mandarin"] .chip-remove');
  });
});
