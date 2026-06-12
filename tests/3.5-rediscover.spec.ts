// 3.5 — Re-discover button + NL-hint text input.
//
// Gate from tasks.md:
//   "type a hint, re-discover → second LLM call recorded; new schema
//    replaces the cached one."
//
// Three concerns, three tests:
//   1. Orchestrator force semantics — `getOrDiscover` with `force:true`
//      bypasses cache.get and overwrites the cache on success.
//   2. discover() wiring — `force:true` and `hint` are forwarded through
//      the content-side orchestrator into the fetchSchema callback.
//   3. UI — page-status renders a re-discover input + button; clicking
//      with a hint fires `onRediscover({ hint, force:true })`.
//
// Production wiring (panel → content → SW → getOrDiscover) is the Slice-3
// production-wire capstone; 3.5's gate is satisfied by the orchestrator
// semantics + UI callback combination tested here.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const FIRST_SCHEMA = {
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > .job',
  fields: { title: { kind: 'text', selector: '.title' } },
};

const SECOND_SCHEMA = {
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > article.job',
  fields: {
    title: { kind: 'text', selector: '.title' },
    snippet: { kind: 'text', selector: '.snippet' },
  },
  detailLinkSelector: '.title a',
};

test.describe('3.5 — re-discover + hint', () => {
  test('getOrDiscover force:true bypasses cache + overwrites; without force cache hit = 0 LLM calls', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(
        async (resp) => {
          const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
          const cache = nf.memorySchemaCache();
          let call = 0;
          const responses = [resp.first, resp.second, resp.second];
          const mockFetch: typeof fetch = async () => {
            const text = JSON.stringify(responses[call] ?? resp.first);
            call += 1;
            return new Response(
              JSON.stringify({ content: [{ type: 'text', text }] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          };
          const deps = {
            cache,
            loadSettings: async () => ({
              provider: 'anthropic' as const,
              apiKey: 'sk-test',
            }),
            fetcher: mockFetch,
          };

          // First call → cache miss → LLM call 1 → FIRST_SCHEMA cached.
          const a = await nf.getOrDiscover({ fingerprint: 'fp1', distilled: '<x/>' }, deps);
          const afterFirst = call;

          // Second call (no force) → cache hit → still 1 LLM call total.
          const b = await nf.getOrDiscover({ fingerprint: 'fp1', distilled: '<x/>' }, deps);
          const afterSecond = call;

          // Third call (force:true) → bypass cache → LLM call 2 → cache overwritten.
          const c = await nf.getOrDiscover(
            { fingerprint: 'fp1', distilled: '<x/>', force: true, hint: 'use h2 not h3' },
            deps,
          );
          const afterThird = call;

          // Fourth call (no force) → cache hit on the NEW value.
          const d = await nf.getOrDiscover({ fingerprint: 'fp1', distilled: '<x/>' }, deps);
          const afterFourth = call;

          return {
            afterFirst,
            afterSecond,
            afterThird,
            afterFourth,
            firstItemSelector: a.itemSelector,
            secondItemSelector: b.itemSelector,
            thirdItemSelector: c.itemSelector,
            fourthItemSelector: d.itemSelector,
          };
        },
        { first: FIRST_SCHEMA, second: SECOND_SCHEMA },
      );

      // Gate: second LLM call recorded only after the force:true call.
      expect(result.afterFirst).toBe(1);
      expect(result.afterSecond).toBe(1); // cache hit, no new call
      expect(result.afterThird).toBe(2); // force bypassed cache
      expect(result.afterFourth).toBe(2); // overwrite reads from cache

      // New schema replaces the cached one.
      expect(result.firstItemSelector).toBe(FIRST_SCHEMA.itemSelector);
      expect(result.secondItemSelector).toBe(FIRST_SCHEMA.itemSelector);
      expect(result.thirdItemSelector).toBe(SECOND_SCHEMA.itemSelector);
      expect(result.fourthItemSelector).toBe(SECOND_SCHEMA.itemSelector);
    } finally {
      await browser.close();
    }
  });

  test('discover({force, hint}) forwards both to the fetchSchema callback', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      // Synthetic page so detect can find an item-set.
      await page.setContent(
        '<main class="joblist"><article class="job"><h2 class="title">A</h2></article><article class="job"><h2 class="title">B</h2></article><article class="job"><h2 class="title">C</h2></article></main>',
      );
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const captured: Array<{
          fingerprint: string;
          force?: boolean;
          hint?: string;
        }> = [];
        const fetchSchema = async (req: {
          fingerprint: string;
          distilled: string;
          layout: 'list' | 'carousel' | 'grid';
          hint?: string;
          force?: boolean;
        }) => {
          const seen: { fingerprint: string; force?: boolean; hint?: string } = {
            fingerprint: req.fingerprint,
          };
          if (req.force !== undefined) seen.force = req.force;
          if (req.hint !== undefined) seen.hint = req.hint;
          captured.push(seen);
          // Return a minimal valid schema.
          return {
            fingerprint: req.fingerprint,
            layout: req.layout,
            itemSetSelector: '.joblist',
            itemSelector: '.joblist > .job',
            fields: { title: { kind: 'text' as const, selector: '.title' } },
            source: 'llm' as const,
            discoveredAt: 0,
          };
        };

        await nf.discover(document, { fetchSchema });
        await nf.discover(document, { fetchSchema }, { force: true, hint: 'h2 not h3' });
        await nf.discover(document, { fetchSchema }, { hint: 'only hint' });
        return captured;
      });

      expect(result).toHaveLength(3);
      expect(result[0]?.force).toBeUndefined();
      expect(result[0]?.hint).toBeUndefined();
      expect(result[1]?.force).toBe(true);
      expect(result[1]?.hint).toBe('h2 not h3');
      expect(result[2]?.force).toBeUndefined();
      expect(result[2]?.hint).toBe('only hint');
    } finally {
      await browser.close();
    }
  });

  test('page-status: clicking Re-discover fires onRediscover with hint + force:true', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      // Mount renderPageStatus directly. The testbed runtime is content-
      // side; for this UI smoke we use the panel bundle's render fn via a
      // dynamic import-like trick: copy the source surface inline.
      // Cheapest: synthesize a minimal host and call the component via the
      // panel.js bundle? Simpler — render straight from the testbed-bundled
      // path. We add renderPageStatus to the testbed in this slice.
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const host = document.createElement('section');
        host.id = 'page-status-test-host';
        document.body.appendChild(host);

        interface Capture {
          hint?: string;
          force: true;
        }
        const captured: Capture[] = [];
        nf.renderPageStatus(host, {
          schema: {
            fingerprint: 'fp',
            layout: 'list',
            itemSetSelector: '.joblist',
            itemSelector: '.joblist > .job',
            fields: { title: { kind: 'text', selector: '.title' } },
            source: 'llm',
            discoveredAt: 0,
          },
          itemCount: 10,
          mode: 'collapse',
          onModeChange: () => undefined,
          onRediscover: (payload) => captured.push(payload),
        });

        // Re-discover input + button should be present.
        const input = host.querySelector<HTMLInputElement>('[data-input="rediscover-hint"]');
        const button = host.querySelector<HTMLButtonElement>('[data-action="rediscover"]');
        if (!input || !button) throw new Error('UI not rendered');

        // Click with no hint → payload has force:true only.
        button.click();

        // Type hint, click again → payload has both.
        input.value = 'the title lives in the h3, not the h2';
        button.click();

        return captured;
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ force: true });
      expect(result[1]).toEqual({
        force: true,
        hint: 'the title lives in the h3, not the h2',
      });
    } finally {
      await browser.close();
    }
  });

  test('page-status: Re-discover renders even with NO schema (enabled-but-undetected dead-end)', async () => {
    // The missing-schema error row tells the user to "Use Re-discover
    // (above)" — so the control must exist precisely when there is no
    // schema. This locks in the fix for the dead-end where the rediscover
    // block was gated behind `state.schema`.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.addScriptTag({ path: TESTBED });
      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const host = document.createElement('section');
        document.body.appendChild(host);

        interface Capture {
          hint?: string;
          force: true;
        }
        const captured: Capture[] = [];
        nf.renderPageStatus(host, {
          schema: null,
          itemCount: 0,
          mode: 'collapse',
          onModeChange: () => undefined,
          onRediscover: (payload) => captured.push(payload),
        });

        const input = host.querySelector<HTMLInputElement>('[data-input="rediscover-hint"]');
        const button = host.querySelector<HTMLButtonElement>('[data-action="rediscover"]');
        if (!input || !button) throw new Error('Re-discover UI not rendered without schema');

        input.value = 'job cards in the main column';
        button.click();

        return {
          captured,
          statusText: host.querySelector('.section-meta')?.textContent ?? '',
          // The display-mode toggle still needs a schema — only the
          // rediscover block is unconditional.
          hasModeToggle: host.querySelector('[data-role="display-mode"]') !== null,
        };
      });

      expect(result.hasModeToggle).toBe(false);
      expect(result.statusText).toContain('No list detected');
      expect(result.captured).toEqual([
        { force: true, hint: 'job cards in the main column' },
      ]);
    } finally {
      await browser.close();
    }
  });
});
