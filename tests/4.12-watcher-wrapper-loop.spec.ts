// 4.12 — MutationWatcher must never ingest renderer-owned nodes as items.
//
// With a tag-only scoped itemSelector (`div.list > div` — what
// localizeItemSet produces for classless cards, seen live on github.com
// search) the renderer's `.filt` wrapper div itself matches the selector.
// Before the fix, the watcher fed the wrapper back as a "new item", the
// engine filtered it (it contains the card's text), the renderer wrapped
// the wrapper — an infinite loop that wedged the page's main thread.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('4.12 — wrapper nodes are not re-ingested as items', () => {
  test('tag-only selector: renderer wrap does not trigger onItemsAdded', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="list">
          <div><h3>Alpha role</h3><p>Mentions blockchain heavily</p></div>
          <div><h3>Beta role</h3><p>Plain backend work</p></div>
          <div><h3>Gamma role</h3><p>More blockchain things</p></div>
          <div><h3>Delta role</h3><p>Compilers</p></div>
        </div>
      `);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = window.__nf;
        const schema = {
          fingerprint: 'test:tag-only',
          layout: 'list' as const,
          itemSetSelector: 'div.list',
          itemSelector: 'div.list > div',
          fields: {},
          source: 'local' as const,
          discoveredAt: 0,
        };
        const itemSet = document.querySelector('div.list')!;
        const ingested: string[] = [];
        const watcher = new nf.MutationWatcher({
          itemSet,
          itemSelector: schema.itemSelector,
          onItemsAdded: (added: Element[]) => {
            for (const el of added) ingested.push(el.className || el.tagName);
          },
        });
        watcher.start();

        const renderer = new nf.Renderer({
          schema,
          itemSet,
          onRestoreToggle: () => undefined,
        });
        const items = nf.findItems(schema);
        const filter = {
          id: 'kw',
          fingerprint: schema.fingerprint,
          field: '*',
          polarity: 'exclude' as const,
          deep: false,
          saved: false,
          predicate: { op: 'containsAny' as const, phrases: ['blockchain'] },
        };
        renderer.apply(nf.evaluate(schema, items, [filter]));

        // The watcher flushes on a microtask; give it two macrotasks so a
        // would-be loop has every chance to fire before we sample.
        await new Promise((r) => setTimeout(r, 50));
        const ingestedAfterWrap = [...ingested];

        // A genuinely new card must still flow through — the renderer-node
        // skip must not blind the watcher to real additions.
        const late = document.createElement('div');
        late.innerHTML = '<h3>Epsilon role</h3><p>Late-loaded</p>';
        itemSet.appendChild(late);
        await new Promise((r) => setTimeout(r, 50));

        return {
          ingestedAfterWrap,
          ingestedFinal: ingested,
          wrappers: document.querySelectorAll('.filt').length,
          nestedWrappers: document.querySelectorAll('.filt .filt').length,
        };
      });

      expect(result.wrappers).toBe(2);
      expect(result.nestedWrappers).toBe(0);
      expect(result.ingestedAfterWrap).toHaveLength(0);
      expect(result.ingestedFinal).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
});
