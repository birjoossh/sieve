// 2.9 — deep-text: fetch each item's detail description so the free-text
// keyword filter can match content that isn't on the card (LinkedIn job
// descriptions). Covers stripHtml, itemDetailUrl, the DeepTextScanner's
// cache/throttle, and the engine folding detailText into ALL_TEXT_FIELD.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('2.9 — deep-text (in-body keyword filtering)', () => {
  test('engine folds fetched description text into ALL_TEXT matching', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'linkedin-jobs.html')).href);
    await page.addScriptTag({ path: TESTBED });

    const r = await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const local = nf.buildLocalSchema(document)!;
      const items = nf.findItems(local.schema);

      // "clearance" appears on no card; inject it as detail text for one item.
      const detail = new Map<Element, string>([
        [items[2]!, 'Active security clearance required'],
      ]);
      const filter = nf.makeFilter({
        id: 'kw',
        fingerprint: local.schema.fingerprint,
        field: '*',
        predicate: { op: 'containsAny', phrases: ['clearance'] },
      });

      const without = nf.evaluate(local.schema, items, [filter]);
      const withDetail = nf.evaluate(local.schema, items, [filter], detail);
      const tally = (m: Map<Element, { state: string }>) =>
        [...m.values()].filter((v) => v.state === 'filtered').length;
      return { without: tally(without), withDetail: tally(withDetail) };
    });

    // No card text matches; only the detail-text fold hides exactly one.
    expect(r.without).toBe(0);
    expect(r.withDetail).toBe(1);
    await browser.close();
  });

  test('stripHtml, itemDetailUrl, and DeepTextScanner cache/throttle', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'linkedin-jobs.html')).href);
    await page.addScriptTag({ path: TESTBED });

    const r = await page.evaluate(async () => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;

      const stripped = nf.stripHtml('<div>Hello <script>bad()</script><b>World</b></div>');

      const host = document.createElement('div');
      host.innerHTML = '<a href="/jobs/view/987654/?ref=x">job</a>';
      const url = nf.itemDetailUrl(host);

      // Occluded/virtualized card: no rendered link, only the stable data
      // attribute. Must still resolve (the bug that left 18/25 cards unscanned).
      const occluded = document.createElement('li');
      occluded.setAttribute('data-occludable-job-id', '555111');
      const occludedUrl = nf.itemDetailUrl(occluded);

      // Scanner with a mock fetcher: 3 items, dedup + cache.
      const items = [1, 2, 3].map((i) => {
        const li = document.createElement('li');
        li.innerHTML = `<a href="/jobs/view/${i}00">j${i}</a>`;
        return li;
      });
      let fetches = 0;
      const seen: string[] = [];
      const scanner = new nf.DeepTextScanner({
        concurrency: 2,
        spacingMs: 0,
        fetchText: async (u: string) => {
          fetches += 1;
          return `text:${u}`;
        },
        onText: (_item: Element, text: string) => seen.push(text),
      });
      scanner.scan(items);
      scanner.scan(items); // immediate re-scan must not double-fetch
      await new Promise((res) => setTimeout(res, 150));

      return { stripped, url, occludedUrl, fetches, seenCount: seen.length };
    });

    expect(r.stripped).toBe('Hello World');
    expect(r.url).toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/987654');
    expect(r.occludedUrl).toBe('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/555111');
    expect(r.fetches).toBe(3);
    expect(r.seenCount).toBe(3);
    await browser.close();
  });

  test('429 → shared cooldown + re-queue; text delivered after backoff; attempts capped', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, 'linkedin-jobs.html')).href);
    await page.addScriptTag({ path: TESTBED });

    const r = await page.evaluate(async () => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const mk = (id: number) => {
        const li = document.createElement('li');
        li.innerHTML = `<a href="/jobs/view/${id}">j${id}</a>`;
        document.body.appendChild(li);
        return li;
      };
      // Case A: first two attempts 429, third succeeds — text must arrive
      // and the burst must pause between attempts (timestamps spread out).
      const limited = mk(9101);
      let aCalls = 0;
      const aTimes: number[] = [];
      const got: string[] = [];
      const a = new nf.DeepTextScanner({
        concurrency: 1,
        spacingMs: 0,
        backoffMs: [120, 120, 120, 120],
        cache: new Map(),
        fetchDetail: async () => {
          aCalls += 1;
          aTimes.push(Date.now());
          if (aCalls < 3) return { text: null, rateLimited: true };
          return { text: 'recovered description', rateLimited: false };
        },
        onText: (_i: Element, t: string) => got.push(t),
      });
      a.scan([limited]);
      await new Promise((res) => setTimeout(res, 900));
      a.stop();

      // Case B: permanent 429 — attempts must cap, not loop forever.
      const dead = mk(9102);
      let bCalls = 0;
      const b = new nf.DeepTextScanner({
        concurrency: 1,
        spacingMs: 0,
        backoffMs: [40, 40, 40, 40],
        cache: new Map(),
        fetchDetail: async () => {
          bCalls += 1;
          return { text: null, rateLimited: true };
        },
        onText: () => undefined,
      });
      b.scan([dead]);
      // Repeated scans must not resurrect a capped URL.
      await new Promise((res) => setTimeout(res, 400));
      b.scan([dead]);
      await new Promise((res) => setTimeout(res, 400));
      b.stop();

      return {
        aCalls,
        got,
        spread: aTimes.length >= 3 ? aTimes[2]! - aTimes[0]! : -1,
        bCalls,
      };
    });

    expect(r.aCalls).toBe(3);
    expect(r.got).toEqual(['recovered description']);
    expect(r.spread).toBeGreaterThanOrEqual(200);
    expect(r.bCalls).toBeLessThanOrEqual(4);
    await browser.close();
  });

  test('scan order is viewport-first: visible cards fetch before below-the-fold ones', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto(pathToFileURL(resolve(FIXTURES, 'linkedin-jobs.html')).href);
    await page.addScriptTag({ path: TESTBED });

    const order = await page.evaluate(async () => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      document.body.innerHTML = '';
      const items: Element[] = [];
      for (let i = 1; i <= 6; i++) {
        const li = document.createElement('li');
        li.style.cssText = 'display:block;height:300px;';
        li.innerHTML = `<a href="/jobs/view/${7000 + i}">j${i}</a>`;
        document.body.appendChild(li);
        items.push(li);
      }
      const fetched: string[] = [];
      const scanner = new nf.DeepTextScanner({
        concurrency: 1,
        spacingMs: 0,
        cache: new Map(),
        fetchDetail: async (u: string) => {
          fetched.push(u.slice(-4));
          return { text: 't', rateLimited: false };
        },
        onText: () => undefined,
      });
      // Hand items over in REVERSE DOM order — the scanner must still fetch
      // the visible top cards first.
      scanner.scan([...items].reverse());
      await new Promise((res) => setTimeout(res, 300));
      return fetched;
    });

    expect(order.slice(0, 2)).toEqual(['7001', '7002']);
    await browser.close();
  });
});
