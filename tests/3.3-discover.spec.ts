// 3.3 — content/discover.ts cache lookup → LLM on miss → schema apply.
//
// Gate from tasks.md:
//   "First visit → 1 LLM call recorded; revisit → 0 LLM calls; schema applies."
//
// Tested via the testbed pattern: an in-memory schemaCache + a counted mock
// fetcher (returning a canned Anthropic envelope wrapping a rolecast-shaped
// Schema). The mock counts net fetcher invocations. discover() runs against
// the live rolecast.html DOM; the returned schema must produce 10 findItems
// matches (i.e. it "applies").
//
// Note: production wiring of `fetchSchema` to a chrome.runtime.sendMessage
// round-trip + sw.ts message handler lands in 3.4 alongside the panel
// trigger. 3.3's gate is satisfied by the orchestrator logic, which is
// what's actually being tested here.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const ROLECAST_SCHEMA_RESPONSE = {
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > .job',
  fields: {
    title: { kind: 'text', selector: '.title' },
    company: { kind: 'text', selector: '.company' },
    location: { kind: 'text', selector: '.location' },
    snippet: { kind: 'text', selector: '.snippet' },
  },
};

interface RunResult {
  fetchCount: number;
  firstSchema: unknown;
  secondSchema: unknown;
  cacheKeyMatches: boolean;
  itemSetMatches: boolean;
  itemsMatchCount: number;
  firstFingerprint: string | null;
  secondFingerprint: string | null;
}

async function runDoubleDiscover(fixture: string): Promise<RunResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, fixture)).href);
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate(async (schemaResp) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;

      let fetchCount = 0;
      const mockFetch: typeof fetch = async () => {
        fetchCount += 1;
        const payload = {
          content: [{ type: 'text', text: JSON.stringify(schemaResp) }],
        };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const cache = nf.memorySchemaCache();
      const fetchSchema = async (req: {
        fingerprint: string;
        distilled: string;
        layout: 'list' | 'carousel' | 'grid';
        hint?: string;
      }) => {
        return nf.getOrDiscover(
          { fingerprint: req.fingerprint, distilled: req.distilled },
          {
            cache,
            loadSettings: async () => ({
              provider: 'anthropic' as const,
              apiKey: 'sk-test-key',
            }),
            fetcher: mockFetch,
            now: () => 1700000000000,
          },
        );
      };

      const first = await nf.discover(document, { fetchSchema });
      const afterFirst = fetchCount;
      const second = await nf.discover(document, { fetchSchema });
      const afterSecond = fetchCount;

      if (!first || !second) throw new Error('discover returned null');

      // Verify the schema actually applies: itemSet selector matches the
      // detected container and the itemSelector finds 10 .job cards.
      const detected = nf.detect(document);
      const matchedSet = document.querySelector(first.schema.itemSetSelector);
      const itemSetMatches = detected === matchedSet && matchedSet === first.itemSet;
      const items = document.querySelectorAll(first.schema.itemSelector);

      // Returned schema must carry the page's fingerprint (cache key bound
      // at construction time, not by the caller).
      const expectedFp = nf.fingerprintItemSet(first.itemSet);

      return {
        fetchCount: afterSecond,
        firstSchema: first.schema,
        secondSchema: second.schema,
        cacheKeyMatches: afterFirst === 1 && afterSecond === 1,
        itemSetMatches,
        itemsMatchCount: items.length,
        firstFingerprint: first.schema.fingerprint,
        secondFingerprint: second.schema.fingerprint,
      };
    }, ROLECAST_SCHEMA_RESPONSE);
  } finally {
    await browser.close();
  }
}

test.describe('3.3 — discover (cache → LLM on miss → schema apply)', () => {
  test('rolecast.html: first call = 1 LLM hit, second call = 0; schema applies', async () => {
    const r = await runDoubleDiscover('rolecast.html');
    // The gate: net LLM calls after two discovers on the same fingerprint = 1.
    expect(r.fetchCount).toBe(1);
    expect(r.cacheKeyMatches).toBe(true);

    // Schema applies: itemSetSelector finds the detected container; itemSelector
    // finds all 10 rolecast cards.
    expect(r.itemSetMatches).toBe(true);
    expect(r.itemsMatchCount).toBe(10);

    // Same fingerprint stamped on both responses (cache returns the cached
    // object as-is).
    expect(r.firstFingerprint).not.toBeNull();
    expect(r.secondFingerprint).toBe(r.firstFingerprint);

    // Returned Schema has source 'llm' (cache hits don't relabel).
    expect((r.firstSchema as { source: string }).source).toBe('llm');
    expect((r.secondSchema as { source: string }).source).toBe('llm');
  });

  test('different fingerprints → 2 LLM calls (cache key is binding)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(async (schemaResp) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        let fetchCount = 0;
        const mockFetch: typeof fetch = async () =>
          (fetchCount++,
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(schemaResp) }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ));
        const cache = nf.memorySchemaCache();
        const deps = {
          cache,
          loadSettings: async () => ({
            provider: 'anthropic' as const,
            apiKey: 'sk-test-key',
          }),
          fetcher: mockFetch,
        };
        await nf.getOrDiscover({ fingerprint: 'fp-A', distilled: '<a/>' }, deps);
        await nf.getOrDiscover({ fingerprint: 'fp-B', distilled: '<b/>' }, deps);
        await nf.getOrDiscover({ fingerprint: 'fp-A', distilled: '<a/>' }, deps);
        return fetchCount;
      }, ROLECAST_SCHEMA_RESPONSE);
      expect(result).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('memorySchemaCache get/set roundtrip', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const cache = nf.memorySchemaCache();
        const before = await cache.get('fp');
        const fake = {
          fingerprint: 'fp',
          layout: 'list' as const,
          itemSetSelector: '.x',
          itemSelector: '.x > .y',
          fields: { t: { kind: 'text' as const, selector: '.t' } },
          source: 'llm' as const,
          discoveredAt: 0,
        };
        await cache.set('fp', fake);
        const after = await cache.get('fp');
        return { before, after };
      });
      expect(result.before).toBeNull();
      expect(result.after).toMatchObject({ fingerprint: 'fp', layout: 'list' });
    } finally {
      await browser.close();
    }
  });
});
