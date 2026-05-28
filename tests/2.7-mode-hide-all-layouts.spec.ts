// 2.7 — mode-hide wired across all three layouts.
//
// Gate from tasks.md:
//   toggle hide on each layout → all `.filt:not(.restored)` are
//   display:none; restored ones remain visible with `↺ re-hide` marker.
//
// Slice 1.8 wrote the css rule (`.mode-hide > .filt:not(.restored) {
// display: none; }`) and the toggle hook (Renderer.setMode). Slice 2 then
// added .layout-carousel + .layout-grid wrappers — but those still carry
// the bare `.filt` class, so the rule already covers them. This test
// proves it across all three fixtures and verifies the restored-row
// affordance still appears in hide mode.

import { test, expect, chromium, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

interface Case {
  name: string;
  file: string;
  itemSet: string;
  itemSelector: string;
  layout: 'list' | 'carousel' | 'grid';
  field: string;
  fieldSelector: string;
  phrase: string;
  expectedFilteredCount: number;
}

const CASES: Case[] = [
  {
    name: 'list (rolecast)',
    file: 'rolecast.html',
    itemSet: '.joblist',
    itemSelector: '.joblist > article.job',
    layout: 'list',
    field: 'snippet',
    fieldSelector: '.snippet',
    phrase: 'Mandarin',
    expectedFilteredCount: 3,
  },
  {
    name: 'carousel (shopcast)',
    file: 'carousel.html',
    itemSet: '.carousel-track',
    itemSelector: '.carousel-track > article.card',
    layout: 'carousel',
    field: 'title',
    fieldSelector: '.title',
    phrase: 'Linen',
    expectedFilteredCount: 2,
  },
  {
    name: 'grid (coursemap)',
    file: 'grid.html',
    itemSet: '.cs-grid',
    itemSelector: '.cs-grid > article.tile',
    layout: 'grid',
    field: 'title',
    fieldSelector: '.title',
    phrase: 'Systems',
    expectedFilteredCount: 2,
  },
];

async function mountAndFilter(page: Page, c: Case): Promise<void> {
  await page.evaluate(
    ({ itemSetSel, itemSel, layout, field, fieldSel, phrase, fingerprint }) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const itemSet = document.querySelector(itemSetSel)!;
      const schema = {
        fingerprint,
        layout: layout as 'list' | 'carousel' | 'grid',
        itemSetSelector: itemSetSel,
        itemSelector: itemSel,
        fields: { [field]: { kind: 'text' as const, selector: fieldSel } },
        source: 'taught' as const,
        discoveredAt: 0,
      };
      const renderer = new nf.Renderer({
        schema,
        itemSet,
        onRestoreToggle: (id, restored) => renderer.setRestored(id, restored),
      });
      const items = Array.from(document.querySelectorAll(itemSel)) as Element[];
      const filter = nf.makeFilter({
        id: `f-${field}-${phrase}`,
        fingerprint,
        field,
        predicate: { op: 'containsAny', phrases: [phrase] },
      });
      const verdicts = nf.evaluate(schema, items, [filter]);
      renderer.apply(verdicts);
      (window as unknown as { __nfRenderer: typeof renderer }).__nfRenderer = renderer;
    },
    {
      itemSetSel: c.itemSet,
      itemSel: c.itemSelector,
      layout: c.layout,
      field: c.field,
      fieldSel: c.fieldSelector,
      phrase: c.phrase,
      fingerprint: `stub-${c.layout}`,
    },
  );
}

test.describe('2.7 — mode-hide across layouts', () => {
  for (const c of CASES) {
    test(`${c.name} — hide collapses .filt:not(.restored); restored stays + .rehide visible`, async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(pathToFileURL(resolve(FIXTURES, c.file)).href);
      await page.addScriptTag({ path: TESTBED });

      await mountAndFilter(page, c);

      // Sanity in collapse mode: expected number of .filt wrappers, all
      // visible (whatever the per-layout sliver is).
      const collapseCounts = await page.evaluate(() => ({
        filtTotal: document.querySelectorAll('.filt').length,
        filtVisible: Array.from(document.querySelectorAll('.filt')).filter(
          (el) => (el as HTMLElement).offsetParent !== null,
        ).length,
      }));
      expect(collapseCounts.filtTotal).toBe(c.expectedFilteredCount);
      expect(collapseCounts.filtVisible).toBe(c.expectedFilteredCount);

      // Switch to hide mode.
      await page.evaluate(() => {
        (window as unknown as { __nfRenderer: { setMode(m: 'hide' | 'collapse'): void } })
          .__nfRenderer.setMode('hide');
      });

      const afterHide = await page.evaluate((itemSetSel) => {
        const wrappers = Array.from(document.querySelectorAll('.filt')) as HTMLElement[];
        return {
          totalWrappers: wrappers.length,
          // offsetParent is null when display:none anywhere in the chain —
          // the cheapest "is this actually in layout?" check.
          visibleWrappers: wrappers.filter((w) => w.offsetParent !== null).length,
          itemSetHasModeHide:
            document.querySelector(itemSetSel)?.classList.contains('mode-hide') ?? false,
        };
      }, c.itemSet);
      expect(afterHide.itemSetHasModeHide, 'setMode("hide") must add .mode-hide to itemSet').toBe(true);

      // No wrappers visible — they're all unrestored .filt's.
      expect(afterHide.totalWrappers).toBe(c.expectedFilteredCount);
      expect(afterHide.visibleWrappers, 'all unrestored .filt must be display:none in hide mode').toBe(0);

      // Restore the first filtered item: it should reappear and show the
      // `↺ re-hide` marker, even while hide mode is on.
      const firstId = await page.evaluate(() => {
        const w = document.querySelector('.filt') as HTMLElement | null;
        return w?.dataset['nfId'] ?? null;
      });
      expect(firstId).not.toBeNull();
      await page.evaluate((id) => {
        (window as unknown as {
          __nfRenderer: { setRestored(id: string, restored: boolean): void };
        }).__nfRenderer.setRestored(id!, true);
      }, firstId);

      const afterRestore = await page.evaluate((id) => {
        const wrapper = document.querySelector(
          `.filt[data-nf-id="${id}"]`,
        ) as HTMLElement;
        const rehide = wrapper.querySelector('.rehide') as HTMLElement;
        return {
          wrapperVisible: wrapper.offsetParent !== null,
          wrapperHasRestored: wrapper.classList.contains('restored'),
          rehideVisible: rehide ? rehide.offsetParent !== null : false,
          rehideText: rehide?.textContent ?? null,
        };
      }, firstId);

      expect(afterRestore.wrapperHasRestored).toBe(true);
      expect(afterRestore.wrapperVisible, 'restored wrapper stays visible in hide mode').toBe(true);
      expect(afterRestore.rehideVisible, '↺ re-hide marker must be visible on the restored wrapper').toBe(true);
      expect(afterRestore.rehideText).toContain('re-hide');

      // The other (still-unrestored) wrappers should remain hidden.
      const stillHidden = await page.evaluate((id) => {
        const others = Array.from(
          document.querySelectorAll('.filt'),
        ).filter((w) => (w as HTMLElement).dataset['nfId'] !== id) as HTMLElement[];
        return {
          count: others.length,
          allHidden: others.every((w) => w.offsetParent === null),
        };
      }, firstId);
      expect(stillHidden.count).toBe(c.expectedFilteredCount - 1);
      expect(stillHidden.allHidden).toBe(true);

      await browser.close();
    });
  }
});
