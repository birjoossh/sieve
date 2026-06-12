// 6.7 — detached render mode + automatic wrap → detached fallback.
//
// fixtures/react-revert.html emulates a React reconciler that owns the list:
// it rips out any inserted wrapper, rescues reparented cards back into
// place, and periodically snaps each card's className back to the vDOM
// value. The renderer must (1) detect its wrappers being reverted and fall
// back to detached mode, (2) collapse items via class + data attributes
// only, (3) restore / re-hide through the delegated click path, (4)
// self-heal when "React" strips its classes, and (5) keep the mode-hide
// contract.
//
// Per memory.md: renderer.summaries() returns a live array — counts are
// snapshotted inside each evaluate, never held across mutations.

import { test, expect, chromium, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(__dirname, '..', 'fixtures', 'react-revert.html')).href;
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

// 'blockchain' appears in the snippets of j-02, j-04, j-07, j-09.
const FILTERS = [
  {
    id: 'f-chain',
    field: 'snippet',
    predicate: { op: 'containsAny', phrases: ['blockchain'] },
  },
] as const;

const FILTERED_IDS = ['j-02', 'j-04', 'j-07', 'j-09'];

interface SummarySnapshot {
  filtered: number;
  passing: number;
  restored: number;
}

async function mount(
  page: Page,
  schemaPatch: { renderMode: 'detached' } | null,
): Promise<SummarySnapshot> {
  await page.addScriptTag({ path: TESTBED });
  return page.evaluate(
    ({ filters, patch }) => {
      const built = filters.map((f) => window.__nf.makeFilter(f));
      const { summaries } = window.__nf.mountRenderer(built, patch);
      return {
        filtered: summaries.filter((s) => s.state === 'filtered').length,
        passing: summaries.filter((s) => s.state === 'passing').length,
        restored: summaries.filter((s) => s.state === 'restored').length,
      };
    },
    {
      filters: FILTERS as unknown as Array<Parameters<NFTestbed['makeFilter']>[0]>,
      patch: schemaPatch,
    },
  );
}

function summaryCounts(page: Page): Promise<SummarySnapshot> {
  return page.evaluate(() => {
    const s = window.__nfRenderer.summaries();
    return {
      filtered: s.filter((x) => x.state === 'filtered').length,
      passing: s.filter((x) => x.state === 'passing').length,
      restored: s.filter((x) => x.state === 'restored').length,
    };
  });
}

function domSnapshot(page: Page): Promise<{
  filtWrappers: number;
  slivers: number;
  listChildren: number;
  foreignChildren: number;
  collapsed: string[];
  collapsedHeights: number[];
}> {
  return page.evaluate(() => {
    const list = document.getElementById('list') as HTMLElement;
    const collapsed = Array.from(
      document.querySelectorAll<HTMLElement>('.nf-filt-item:not(.nf-restored)'),
    );
    return {
      filtWrappers: document.querySelectorAll('.filt').length,
      slivers: document.querySelectorAll('.sliver').length,
      listChildren: list.children.length,
      foreignChildren: Array.from(list.children).filter((c) => !c.matches('article.job'))
        .length,
      collapsed: collapsed.map((el) => el.getAttribute('data-id') ?? ''),
      collapsedHeights: collapsed.map((el) => el.offsetHeight),
    };
  });
}

test.describe('6.7 — detached renderer vs hostile React reconciler', () => {
  test('wrap mode is reverted but the auto-fallback lands items in detached collapse', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);

    const summary = await mount(page, null); // rolecast stub → wrap mode
    expect(summary.filtered).toBe(4);
    expect(summary.passing).toBe(6);

    // The fixture's reconciler removes the wrappers; the renderer's heal
    // observer must notice and re-render the same verdicts detached.
    await page.waitForFunction((expected) => {
      const list = document.getElementById('list') as HTMLElement;
      const collapsed = Array.from(
        document.querySelectorAll<HTMLElement>('.nf-filt-item:not(.nf-restored)'),
      );
      return (
        document.querySelectorAll('.filt, .sliver, .rehide').length === 0 &&
        list.children.length === 10 &&
        Array.from(list.children).every((c) => c.matches('article.job')) &&
        collapsed.length === expected &&
        collapsed.every((el) => el.offsetHeight > 0 && el.offsetHeight <= 32)
      );
    }, FILTERED_IDS.length);

    const dom = await domSnapshot(page);
    expect(dom.collapsed.sort()).toEqual(FILTERED_IDS);
    expect(dom.foreignChildren).toBe(0);

    // Collapsed card content is visually suppressed; the reason rides the
    // data attribute for the ::before pseudo-element.
    const probe = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-id="j-02"]');
      const title = el?.querySelector<HTMLElement>('.title');
      return {
        reason: el?.getAttribute('data-nf-reason') ?? null,
        titleVisibility: title ? getComputedStyle(title).visibility : null,
      };
    });
    expect(probe.reason).toContain('blockchain');
    expect(probe.titleVisibility).toBe('hidden');

    // summaries() contract is identical regardless of render mode.
    expect(await summaryCounts(page)).toEqual({ filtered: 4, passing: 6, restored: 0 });

    await browser.close();
  });

  test('explicit renderMode:detached collapses without ever inserting a wrapper', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);

    const summary = await mount(page, { renderMode: 'detached' });
    expect(summary.filtered).toBe(4);

    const dom = await domSnapshot(page);
    expect(dom.filtWrappers).toBe(0);
    expect(dom.slivers).toBe(0);
    expect(dom.listChildren).toBe(10);
    expect(dom.foreignChildren).toBe(0);
    expect(dom.collapsed.sort()).toEqual(FILTERED_IDS);
    for (const h of dom.collapsedHeights) {
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(32);
    }

    await browser.close();
  });

  test('click restores a collapsed item; bar click re-hides it', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await mount(page, { renderMode: 'detached' });

    const card = page.locator('[data-id="j-02"]');
    await expect(card).toHaveClass(/nf-filt-item/);

    // Collapsed bar is 28px tall — any click on it restores.
    await card.click();
    await expect(card).toHaveClass(/nf-restored/);
    const restoredProbe = await card.evaluate((el) => {
      const title = el.querySelector('.title') as HTMLElement;
      return {
        height: (el as HTMLElement).offsetHeight,
        titleVisibility: getComputedStyle(title).visibility,
      };
    });
    expect(restoredProbe.height).toBeGreaterThan(80);
    expect(restoredProbe.titleVisibility).toBe('visible');
    expect((await summaryCounts(page)).restored).toBe(1);

    // Re-hide: only the pseudo-element bar at the top of the restored card.
    await card.click({ position: { x: 30, y: 10 } });
    await expect(card).not.toHaveClass(/nf-restored/);
    const reCollapsed = await card.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(reCollapsed).toBeLessThanOrEqual(32);
    expect(await summaryCounts(page)).toEqual({ filtered: 4, passing: 6, restored: 0 });

    await browser.close();
  });

  test('self-heal: a React re-render stripping the classes is undone within a tick', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await mount(page, { renderMode: 'detached' });

    // j-04 is index 3 in the fixture's originals array.
    const healed = await page.evaluate(async () => {
      const w = window as unknown as { __reactRender(i: number): void };
      const el = document.querySelector<HTMLElement>('[data-id="j-04"]') as HTMLElement;
      w.__reactRender(3);
      const strippedNow = !el.classList.contains('nf-filt-item');
      // One macrotask is enough: observer microtask + heal microtask both
      // run before this timeout fires.
      await new Promise((r) => setTimeout(r, 0));
      return {
        strippedNow,
        healedClass: el.classList.contains('nf-filt-item'),
        healedReason: el.getAttribute('data-nf-reason'),
        height: el.offsetHeight,
      };
    });
    expect(healed.strippedNow).toBe(true);
    expect(healed.healedClass).toBe(true);
    expect(healed.healedReason).toContain('blockchain');
    expect(healed.height).toBeLessThanOrEqual(32);

    await browser.close();
  });

  test('mode-hide removes collapsed items entirely; restored stays visible', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(FIXTURE);
    await mount(page, { renderMode: 'detached' });

    const restoredId = await page.evaluate(() => {
      const r = window.__nfRenderer;
      const first = r.summaries().find((s) => s.state === 'filtered');
      if (!first) throw new Error('no filtered item');
      r.setRestored(first.id, true);
      r.setMode('hide');
      return first.id;
    });

    const probe = await page.evaluate((restoredId) => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('#list > article.job'),
      );
      const byId = (id: string): HTMLElement | undefined =>
        items.find((el) => el.getAttribute('data-id') === id);
      const hiddenFiltered = items.filter(
        (el) => el.classList.contains('nf-filt-item') && !el.classList.contains('nf-restored'),
      );
      return {
        restoredHeight: byId(restoredId)?.offsetHeight ?? -1,
        hiddenHeights: hiddenFiltered.map((el) => el.offsetHeight),
        hiddenOffsetParents: hiddenFiltered.map((el) => el.offsetParent === null),
        passingHeight: byId('j-01')?.offsetHeight ?? -1,
      };
    }, restoredId);

    expect(probe.restoredHeight).toBeGreaterThan(80);
    expect(probe.hiddenHeights).toEqual([0, 0, 0]);
    expect(probe.hiddenOffsetParents).toEqual([true, true, true]);
    expect(probe.passingHeight).toBeGreaterThan(80);

    // Back to collapse: the three re-appear as 28px bars.
    await page.evaluate(() => window.__nfRenderer.setMode('collapse'));
    const heights = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.nf-filt-item:not(.nf-restored)'),
      ).map((el) => el.offsetHeight),
    );
    expect(heights).toHaveLength(3);
    for (const h of heights) {
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(32);
    }

    await browser.close();
  });
});
