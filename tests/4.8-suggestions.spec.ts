// 4.8 — LLM phrasing-suggestion engine (suggestPhrases in background/llm.ts).
//
// Engine-layer only: suggestPhrases parses the provider response (deduped vs
// existing phrases) through a mock fetcher. The panel's ✦ button no longer
// calls this — it sources suggestions locally from the page's detected items
// (user bug #1); that UI flow is covered by 4.15-local-suggestions.spec.ts.
// suggestPhrases stays for future features, so its unit coverage stays here.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
