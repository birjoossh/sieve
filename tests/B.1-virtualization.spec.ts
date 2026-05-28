// Spike B / 6.1 — DOM virtualization handling.
//
// Gate from tasks.md (B.1 + 6.1):
//   "scroll a virtualized fixture 5 viewports; assert no .filt/.restored
//    state leaks onto recycled nodes; engine evaluates each node by
//    content, not identity."
//
// The virtualized fixture rotates a 12-element ring of <article> nodes
// across 200 logical rows: same Element reference, new data-id +
// content on scroll. The renderer detects the recycled node via
// `handleRecycledItem` (data-id comparison vs cached id), unwraps any
// stale `.filt` wrapper, and re-evaluates against the new content.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('B.1 / 6.1 — virtualization survival', () => {
  test('5-viewport scroll on virtualized fixture → no stale .filt on recycled nodes', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(pathToFileURL(resolve(FIXTURES, 'virtualized.html')).href);
      await page.addScriptTag({ path: TESTBED });

      // Mount a renderer with a Mandarin phrase filter. The fixture's
      // schema is hand-rolled here — the stub schema doesn't match the
      // virtualized .joblist (which lives inside a scrollable
      // container, not at body). We construct a Schema inline.
      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const schema = {
          fingerprint: 'fixture:virt:v1',
          layout: 'list' as const,
          itemSetSelector: '#list',
          // Descendant selector so wrapped items (now nested inside
          // `.filt`) still match — the engine reads identity from
          // data-id, not from being a direct child.
          itemSelector: '#list article.job',
          fields: {
            title: { kind: 'text' as const, selector: '.title' },
            snippet: { kind: 'text' as const, selector: '.snippet' },
          },
          source: 'stub' as const,
          discoveredAt: 0,
        };
        const itemSet = document.querySelector(schema.itemSetSelector)!;
        const renderer = new nf.Renderer({
          schema,
          itemSet,
          onRestoreToggle: (id, r) => renderer.setRestored(id, r),
        });
        (window as unknown as { __renderer: typeof renderer }).__renderer = renderer;

        const filter = nf.makeFilter({
          id: 'mandarin',
          fingerprint: schema.fingerprint,
          field: 'snippet',
          predicate: { op: 'containsAny', phrases: ['Mandarin'] },
        });

        // Pure helper to re-evaluate against the live ring.
        const evalNow = () => {
          const items = nf.findItems(schema);
          const verdicts = nf.evaluate(schema, items, [filter]);
          renderer.apply(verdicts);
          return {
            slivers: document.querySelectorAll('.sliver').length,
            articles: items.length,
            visibleArticles: items.filter(
              (el) => (el as HTMLElement).style.display !== 'none',
            ).length,
          };
        };

        const samples: Array<{ scroll: number; slivers: number; articles: number; visible: number }> = [];

        // Initial render — sample slivers from rows 0..11. 4 carry
        // Mandarin (1, 4, 7, 10).
        const init = evalNow();
        samples.push({ scroll: 0, slivers: init.slivers, articles: init.articles, visible: init.visibleArticles });

        const list = document.getElementById('list')!;
        const viewportH = list.clientHeight;
        // Scroll 5 viewports, re-evaluating each step.
        for (let v = 1; v <= 5; v++) {
          list.scrollTop = v * viewportH;
          // Let the virtualizer's scroll handler run.
          await new Promise((r) => setTimeout(r, 50));
          const s = evalNow();
          samples.push({
            scroll: list.scrollTop,
            slivers: s.slivers,
            articles: s.articles,
            visible: s.visibleArticles,
          });
        }
        return samples;
      });

      // Lock-in assertions:
      //  - Every sample shows a bounded sliver count tied to the
      //    ring size (12 elements; ~1/3 ≈ 4 with the fixture's
      //    "every 3rd row is Mandarin" pattern).
      //  - Critically, the sliver count NEVER grows past 4 — if the
      //    renderer leaked .filt onto recycled nodes, the count
      //    would compound across scroll steps.
      for (const s of result) {
        expect(s.slivers).toBeLessThanOrEqual(4);
      }
      // The first sample sees rows 0..11 → 4 Mandarin rows.
      expect(result[0]?.slivers).toBe(4);
      // After scrolling, the count is in {3, 4} depending on which
      // rows are in view; assert it's always positive (we're seeing
      // some Mandarin rows) and bounded by 4.
      for (const s of result.slice(1)) {
        expect(s.slivers).toBeGreaterThanOrEqual(3);
        expect(s.slivers).toBeLessThanOrEqual(4);
      }
    } finally {
      await browser.close();
    }
  });
});
