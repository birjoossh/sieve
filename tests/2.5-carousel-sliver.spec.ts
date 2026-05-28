// 2.5 — Renderer paints a vertical sliver for carousel layout.
//
// Gate from tasks.md:
//   filtered cards in a carousel render `.sliver-v` (~46 px wide,
//   rotated reason text); track still horizontally scrollable.
//
// Drives Renderer directly through the testbed with an inline carousel
// schema (no schema-stub for carousels yet — that lands when Slice 3's
// discover.ts replaces the stub entirely). Filter: "Linen" → 2 of the 10
// product cards match (Linen Bucket Hat, Linen Pouch).

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(
  resolve(__dirname, '..', 'fixtures', 'carousel.html'),
).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('2.5 — carousel vertical sliver', () => {
  test('filtered cards become .sliver-v (~46 px), track stays horizontally scrollable', async () => {
    const browser = await chromium.launch({ headless: true });
    // Narrow viewport so the 10-card track is wider than the viewport —
    // confirms horizontal scrollability after filtering.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(FIXTURE);
    await page.addScriptTag({ path: TESTBED });

    const before = await page.evaluate(() => {
      const track = document.querySelector('.carousel-track') as HTMLElement;
      return {
        cardCount: document.querySelectorAll('.carousel-track > article.card').length,
        scrollWidth: track.scrollWidth,
        clientWidth: track.clientWidth,
        overflowX: getComputedStyle(track).overflowX,
      };
    });
    expect(before.cardCount).toBe(10);
    // Pre-filter, the track must already overflow — otherwise the test
    // can't tell us anything about post-filter scrollability.
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);

    const result = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const itemSet = document.querySelector('.carousel-track')!;
      const schema = {
        fingerprint: 'shopcast-carousel-stub',
        layout: 'carousel' as const,
        itemSetSelector: '.carousel-track',
        itemSelector: '.carousel-track > article.card',
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
        id: 'f-linen',
        fingerprint: schema.fingerprint,
        field: 'title',
        predicate: { op: 'containsAny', phrases: ['Linen'] },
      });
      const verdicts = nf.evaluate(schema, items, [filter]);
      renderer.apply(verdicts);

      const slivers = Array.from(
        document.querySelectorAll('.filt.layout-carousel > .sliver-v'),
      ) as HTMLElement[];
      const sliverSizes = slivers.map((s) => {
        const rect = s.getBoundingClientRect();
        return { width: rect.width, writingMode: getComputedStyle(s).writingMode };
      });
      const wrapperWidths = Array.from(
        document.querySelectorAll('.filt.layout-carousel'),
      ).map((w) => (w as HTMLElement).getBoundingClientRect().width);

      const track = document.querySelector('.carousel-track') as HTMLElement;
      return {
        sliverCount: slivers.length,
        sliverSizes,
        wrapperWidths,
        // Passing cards are still direct children of the track; filtered
        // ones are nested under `.filt` wrappers.
        passingDirectChildren: document.querySelectorAll(
          '.carousel-track > article.card',
        ).length,
        scrollWidth: track.scrollWidth,
        clientWidth: track.clientWidth,
        overflowX: getComputedStyle(track).overflowX,
        flexDirection: getComputedStyle(track).flexDirection,
      };
    });

    // Two cards match "Linen" → two .sliver-v elements appear.
    expect(result.sliverCount).toBe(2);

    // Each sliver wrapper is the ~46 px the spec calls for (allow ±2 px
    // for box-model rounding).
    for (const w of result.wrapperWidths) {
      expect(Math.round(w)).toBeGreaterThanOrEqual(44);
      expect(Math.round(w)).toBeLessThanOrEqual(48);
    }
    // The sliver itself fills its wrapper.
    for (const s of result.sliverSizes) {
      expect(Math.round(s.width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(s.width)).toBeLessThanOrEqual(48);
      expect(s.writingMode).toBe('vertical-rl');
    }

    // 8 of 10 cards passed → still direct children of the track. The 2
    // filtered cards moved inside `.filt` wrappers and no longer match
    // the direct-child selector.
    expect(result.passingDirectChildren).toBe(8);

    // Track is still a horizontal flex container that overflows → scrollable.
    expect(result.flexDirection).toBe('row');
    expect(result.overflowX).toBe('auto');
    expect(result.scrollWidth).toBeGreaterThan(result.clientWidth);

    await browser.close();
  });
});
