// 5.2 — Hidden-tab spawn + completion routing via chrome.tabs.create({active:false}).
//
// Gate from tasks.md:
//   "enqueue one; assert exactly one hidden tab opens, closes after
//    detail extraction."
//
// We validate the contract via the runOne() lifecycle: it must call
// `tabs.create({active:false})` exactly once, await an external
// "detail ready" signal, and then `tabs.remove()` the same tab id.
// The pluggable TabsLike stub lets us assert call counts + arg shapes
// without spawning a real Chromium tab (a real-tab test belongs at the
// extension-integration layer; 5.3 + 5.6 land that).

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('5.2 — hidden-tab spawn + completion routing', () => {
  test('runOne opens exactly one hidden tab and closes it after the detail signal', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;

        const createCalls: chrome.tabs.CreateProperties[] = [];
        const removedTabs: number[] = [];
        const tabs = {
          async create(p: chrome.tabs.CreateProperties) {
            createCalls.push(p);
            return { id: 42 } as chrome.tabs.Tab;
          },
          async remove(id: number) {
            removedTabs.push(id);
          },
        };

        let signalResolved = false;
        const awaitDetail = async (tabId: number): Promise<Record<string, string>> => {
          // Defer a microtask so the test exercises the await arm —
          // not a synchronous resolve.
          await Promise.resolve();
          signalResolved = true;
          return { tabId: String(tabId), salary: '180k', team: 'platform' };
        };

        const detail = await nf.runOne('https://example.com/role/123', {
          tabs,
          awaitDetail,
          now: () => 1_000,
          timeoutMs: 1_000,
        });

        return {
          createCalls,
          removedTabs,
          signalResolved,
          detail,
        };
      });

      // Exactly one tab created, hidden (active:false), with the
      // requested URL. We use Playwright's expect on the harvested
      // call args.
      expect(result.createCalls).toHaveLength(1);
      expect(result.createCalls[0]).toEqual({
        url: 'https://example.com/role/123',
        active: false,
      });
      // Awaiter ran (proved the signal was honored, not skipped).
      expect(result.signalResolved).toBe(true);
      // Tab id removed exactly once.
      expect(result.removedTabs).toEqual([42]);
      // Fields surfaced through.
      expect(result.detail.fields).toEqual({
        tabId: '42',
        salary: '180k',
        team: 'platform',
      });
      expect(result.detail.itemUrl).toBe('https://example.com/role/123');
    } finally {
      await browser.close();
    }
  });

  test('runOne removes the tab on timeout (no leaked hidden tabs)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;

        const removedTabs: number[] = [];
        const tabs = {
          async create(_: chrome.tabs.CreateProperties) {
            return { id: 99 } as chrome.tabs.Tab;
          },
          async remove(id: number) {
            removedTabs.push(id);
          },
        };
        const awaitDetail = async () => {
          // Never resolves — forces timeout.
          await new Promise(() => {});
          return {};
        };

        let caught: string | null = null;
        try {
          await nf.runOne('https://example.com/role/never', {
            tabs,
            awaitDetail,
            timeoutMs: 20,
          });
        } catch (err) {
          caught = err instanceof Error ? err.message : String(err);
        }
        return { caught, removedTabs };
      });

      expect(result.caught).toMatch(/timed out/);
      // Even on timeout the tab gets cleaned up.
      expect(result.removedTabs).toEqual([99]);
    } finally {
      await browser.close();
    }
  });
});
