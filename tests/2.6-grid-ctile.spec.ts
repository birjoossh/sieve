// 2.6 — Renderer paints a footprint-preserving placeholder cell for grid
// layout.
//
// Gate from tasks.md:
//   filtered cells in a 4-col grid render `.ctile`; grid stays 4-col;
//   no gaps from missing cells.
//
// Strategy: mount Renderer with an inline grid schema on grid.html
// (3 rows × 4 cols = 12 tiles). Filter `Systems` (matches "Operating
// Systems", "Distributed Systems") + `Compilers` → 3 cells. After apply():
//   - `.cs-grid` still has 12 direct children (wrappers replaced the
//     filtered tiles 1:1)
//   - 3 of those direct children are `.filt.layout-grid` (each contains
//     one `.ctile`)
//   - getComputedStyle on the grid still reports 4 column tracks
//   - the row-tops of the 12 cells fall on exactly 3 distinct y values
//     (no orphaned cell got pushed onto a 4th row from missing footprint)

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(
  resolve(__dirname, '..', 'fixtures', 'grid.html'),
).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('2.6 — grid placeholder tile', () => {
  test('3 filtered cells become .ctile; grid stays 4-col with no row-gap', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    const before = await page.evaluate(() => {
      const grid = document.querySelector('.cs-grid') as HTMLElement;
      return {
        childCount: grid.children.length,
        columnTemplate: getComputedStyle(grid).gridTemplateColumns,
      };
    });
    expect(before.childCount).toBe(12);
    // 4 column tracks → 4 space-separated lengths.
    expect(before.columnTemplate.split(/\s+/).length).toBe(4);

    const result = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const itemSet = document.querySelector('.cs-grid')!;
      const schema = {
        fingerprint: 'coursemap-grid-stub',
        layout: 'grid' as const,
        itemSetSelector: '.cs-grid',
        itemSelector: '.cs-grid > article.tile',
        fields: {
          title: { kind: 'text' as const, selector: '.title' },
        },
        source: 'taught' as const,
        discoveredAt: 0,
      };

      const renderer = new nf.Renderer({
        schema,
        itemSet,
        onRestoreToggle: (id, restored) => renderer.setRestored(id, restored),
      });
      const items = Array.from(
        document.querySelectorAll(schema.itemSelector),
      ) as Element[];
      const filter = nf.makeFilter({
        id: 'f-cs-systems',
        fingerprint: schema.fingerprint,
        field: 'title',
        predicate: { op: 'containsAny', phrases: ['Systems', 'Compilers'] },
      });
      const verdicts = nf.evaluate(schema, items, [filter]);
      renderer.apply(verdicts);

      const grid = document.querySelector('.cs-grid') as HTMLElement;
      const directChildren = Array.from(grid.children) as HTMLElement[];
      const ctiles = Array.from(
        document.querySelectorAll('.filt.layout-grid > .ctile'),
      ) as HTMLElement[];
      const wrappers = directChildren.filter((c) =>
        c.classList.contains('filt'),
      );

      // Row-tops: how many distinct y positions across all 12 direct
      // children? With 4 cols and 12 children, this should be exactly 3.
      const tops = directChildren.map((c) =>
        Math.round(c.getBoundingClientRect().top),
      );
      const distinctTops = Array.from(new Set(tops)).sort((a, b) => a - b);

      // Sample width: a wrapper cell should be roughly the same width as a
      // passing tile (within a few px) — that's what "footprint-preserving"
      // means in this gate.
      const passingTile = directChildren.find(
        (c) => c.classList.contains('tile'),
      ) as HTMLElement;
      const passingWidth = passingTile.getBoundingClientRect().width;
      const wrapperWidths = wrappers.map((w) => w.getBoundingClientRect().width);

      return {
        gridChildCount: grid.children.length,
        wrapperCount: wrappers.length,
        ctileCount: ctiles.length,
        columnTemplate: getComputedStyle(grid).gridTemplateColumns,
        distinctTopCount: distinctTops.length,
        passingWidth,
        wrapperWidths,
      };
    });

    expect(result.gridChildCount, 'every original cell still occupies a grid slot').toBe(12);
    expect(result.wrapperCount, '3 filtered cells become .filt wrappers').toBe(3);
    expect(result.ctileCount, 'every filt wrapper paints one .ctile').toBe(3);

    // Grid column count is unchanged: still 4 tracks.
    expect(result.columnTemplate.split(/\s+/).length).toBe(4);

    // Footprint preserved → the layout still resolves to 3 rows.
    expect(result.distinctTopCount).toBe(3);

    // Wrapper cell widths match passing tile width (±2 px for box rounding).
    for (const w of result.wrapperWidths) {
      expect(Math.abs(w - result.passingWidth)).toBeLessThanOrEqual(2);
    }

    await browser.close();
  });
});
