// 6.8 — table-part items force detached mode (wrap is invalid inside tables).
//
// fixtures/table-list.html is a news.ycombinator.com-shaped story table:
// items are <tr> directly inside <tbody>. A <div class="filt"> wrapper in
// that position is invalid table structure and collapsed the whole table
// when this was hit live on HN. The renderer must (1) never wrap a table
// part even when the schema says renderMode 'wrap', (2) collapse filtered
// rows to a slim reason row while passing rows render untouched, (3) fall
// back to the row's own text for the HIDDEN-list label when the schema has
// no text fields, (4) round-trip restore.

import { test, expect, chromium, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'table-list.html')).href;
const COMPANIONS_FIXTURE = pathToFileURL(
  resolve(__dirname, '..', 'fixtures', 'table-companions.html'),
).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

// 'AI' matches case-insensitively as a substring: s-001 + s-003 + s-009
// (literal AI), s-005 ("jAIls"), s-006 ("OpenAI").
const FILTERED_IDS = ['s-001', 's-003', 's-005', 's-006', 's-009'];

async function mountTableRenderer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nf = window.__nf;
    const schema = {
      fingerprint: 'test:table-list',
      layout: 'list' as const,
      itemSetSelector: 'table.stories tbody',
      itemSelector: 'table.stories tbody tr.story',
      fields: {},
      source: 'local' as const,
      discoveredAt: 0,
      renderMode: 'wrap' as const,
    };
    const itemSet = document.querySelector(schema.itemSetSelector)!;
    const renderer = new nf.Renderer({
      schema,
      itemSet,
      onRestoreToggle: (id: string, restored: boolean) => renderer.setRestored(id, restored),
    });
    const items = Array.from(document.querySelectorAll(schema.itemSelector));
    const filter = {
      id: 'kw-ai',
      fingerprint: schema.fingerprint,
      field: '*',
      polarity: 'exclude' as const,
      deep: false,
      saved: false,
      predicate: { op: 'containsAny' as const, phrases: ['AI'] },
    };
    const verdicts = nf.evaluate(schema, items, [filter]);
    renderer.apply(verdicts);
    (window as unknown as { __nfRenderer: unknown }).__nfRenderer = renderer;
  });
}

test.describe('6.8 — table rows render detached, never wrapped', () => {
  test('wrap-mode schema on <tr> items → no wrappers, table intact, rows collapsed', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(FIXTURE);
      await page.addScriptTag({ path: TESTBED });
      await mountTableRenderer(page);

      const state = await page.evaluate((filteredIds) => {
        const rows = Array.from(document.querySelectorAll('tr.story'));
        const filtered = rows.filter((r) =>
          filteredIds.includes(r.getAttribute('data-id') ?? ''),
        );
        const passing = rows.filter(
          (r) => !filteredIds.includes(r.getAttribute('data-id') ?? ''),
        );
        return {
          wrappers: document.querySelectorAll('.filt').length,
          rowCount: rows.length,
          filteredMarked: filtered.every((r) => r.classList.contains('nf-filt-item')),
          filteredCellsHidden: filtered.every((r) =>
            Array.from(r.children).every(
              (td) => getComputedStyle(td).display === 'none',
            ),
          ),
          filteredHeights: filtered.map((r) => (r as HTMLElement).clientHeight),
          passingVisible: passing.every((r) => (r as HTMLElement).clientHeight > 30),
          passingUntouched: passing.every((r) => !r.classList.contains('nf-filt-item')),
        };
      }, FILTERED_IDS);

      expect(state.wrappers).toBe(0);
      expect(state.rowCount).toBe(10);
      expect(state.filteredMarked).toBe(true);
      expect(state.filteredCellsHidden).toBe(true);
      // The reason renders as an anonymous table cell — rows keep a slim,
      // visible footprint instead of vanishing or staying full height.
      for (const h of state.filteredHeights) {
        expect(h).toBeGreaterThan(0);
        expect(h).toBeLessThan(46);
      }
      expect(state.passingVisible).toBe(true);
      expect(state.passingUntouched).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('HIDDEN-list labels fall back to row text (no synthetic nf-N ids)', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(FIXTURE);
      await page.addScriptTag({ path: TESTBED });
      await mountTableRenderer(page);

      const labels = await page.evaluate(() => {
        const renderer = (window as unknown as {
          __nfRenderer: { summaries(): { state: string; label?: string }[] };
        }).__nfRenderer;
        return renderer
          .summaries()
          .filter((s) => s.state === 'filtered')
          .map((s) => s.label ?? '');
      });

      expect(labels).toHaveLength(5);
      for (const label of labels) {
        expect(label).not.toMatch(/^nf-\d+$/);
        expect(label.length).toBeGreaterThan(10);
      }
      expect(labels[0]).toContain('AI agent');
    } finally {
      await browser.close();
    }
  });

  test('restore brings the row back; re-hide collapses it again', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(FIXTURE);
      await page.addScriptTag({ path: TESTBED });
      await mountTableRenderer(page);

      const restoredState = await page.evaluate(() => {
        const renderer = (window as unknown as {
          __nfRenderer: { setRestored(id: string, on: boolean): void };
        }).__nfRenderer;
        renderer.setRestored('s-001', true);
        const row = document.querySelector('tr.story[data-id="s-001"]')!;
        return {
          restoredClass: row.classList.contains('nf-restored'),
          cellsVisible: Array.from(row.children).every(
            (td) => getComputedStyle(td).display !== 'none',
          ),
          height: (row as HTMLElement).clientHeight,
        };
      });
      expect(restoredState.restoredClass).toBe(true);
      expect(restoredState.cellsVisible).toBe(true);
      expect(restoredState.height).toBeGreaterThan(30);

      const reHidden = await page.evaluate(() => {
        const renderer = (window as unknown as {
          __nfRenderer: { setRestored(id: string, on: boolean): void };
        }).__nfRenderer;
        renderer.setRestored('s-001', false);
        const row = document.querySelector('tr.story[data-id="s-001"]')!;
        return {
          restoredClass: row.classList.contains('nf-restored'),
          height: (row as HTMLElement).clientHeight,
        };
      });
      expect(reHidden.restoredClass).toBe(false);
      expect(reHidden.height).toBeLessThan(46);
    } finally {
      await browser.close();
    }
  });

  test('multi-row items: companion subtext rows hide and restore with their story', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(COMPANIONS_FIXTURE);
      await page.addScriptTag({ path: TESTBED });
      await page.evaluate(() => {
        const nf = window.__nf;
        const schema = {
          fingerprint: 'test:table-companions',
          layout: 'list' as const,
          itemSetSelector: 'table.stories tbody',
          itemSelector: 'table.stories tbody tr.story',
          fields: {},
          source: 'local' as const,
          discoveredAt: 0,
        };
        const itemSet = document.querySelector(schema.itemSetSelector)!;
        const renderer = new nf.Renderer({
          schema,
          itemSet,
          onRestoreToggle: (id: string, on: boolean) => renderer.setRestored(id, on),
        });
        const items = Array.from(document.querySelectorAll(schema.itemSelector));
        const filter = {
          id: 'kw-ai',
          fingerprint: schema.fingerprint,
          field: '*',
          polarity: 'exclude' as const,
          deep: false,
          saved: false,
          predicate: { op: 'containsAny' as const, phrases: ['AI benchmark'] },
        };
        renderer.apply(nf.evaluate(schema, items, [filter]));
        (window as unknown as { __nfRenderer: unknown }).__nfRenderer = renderer;
      });

      const sub = (id: string) =>
        page.evaluate(
          (forId) =>
            getComputedStyle(document.querySelector(`tr.subtext[data-for="${forId}"]`)!)
              .display,
          id,
        );

      // c-001 is filtered: its subtext row hides with it; others untouched.
      expect(await sub('c-001')).toBe('none');
      expect(await sub('c-002')).not.toBe('none');

      await page.evaluate(() => {
        (window as unknown as {
          __nfRenderer: { setRestored(id: string, on: boolean): void };
        }).__nfRenderer.setRestored('c-001', true);
      });
      expect(await sub('c-001')).not.toBe('none');

      await page.evaluate(() => {
        (window as unknown as {
          __nfRenderer: { setRestored(id: string, on: boolean): void };
        }).__nfRenderer.setRestored('c-001', false);
      });
      expect(await sub('c-001')).toBe('none');
    } finally {
      await browser.close();
    }
  });
});
