// 5.1 — background/queue.ts — persistent deep-scan queue.
//
// Gate from tasks.md:
//   "enqueue 5; force SW termination; queue resumes from alarm
//    wake-up, processes the remaining items."
//
// We simulate "SW termination" by dropping the in-memory queue
// instance while keeping the underlying storage (memoryQueueIO holds
// items in a closure independent of the PersistentQueue instance).
// A fresh instance reads the same store → in-flight items get revived
// → drain resumes from the right place.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('5.1 — persistent queue', () => {
  test('enqueue 5 → process 2 → SW dies mid-process → fresh instance resumes', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;

        // Stable IO + clock for determinism.
        const io = nf.memoryQueueIO();
        let now = 1_000_000;
        const tick = () => ++now;

        const q1 = new nf.PersistentQueue(io, () => tick());
        await q1.enqueue([
          { fingerprint: 'fp', itemUrl: '/a' },
          { fingerprint: 'fp', itemUrl: '/b' },
          { fingerprint: 'fp', itemUrl: '/c' },
          { fingerprint: 'fp', itemUrl: '/d' },
          { fingerprint: 'fp', itemUrl: '/e' },
        ]);

        // Drain 2 → mark done.
        const first = await q1.checkout();
        await q1.markDone(first!);
        const second = await q1.checkout();
        await q1.markDone(second!);

        // Start a 3rd → leave it in-flight (simulates the SW dying
        // mid-process: storage records it as in-flight).
        const third = await q1.checkout();
        const inFlightSnapshot = await q1.snapshot();

        // Simulate SW termination: drop q1, build a new queue over
        // the same IO. init() revives stranded in-flight items.
        const q2 = new nf.PersistentQueue(io, () => tick());
        await q2.init();

        const postReviveSnapshot = await q2.snapshot();

        // Drain the rest.
        const drained: string[] = [];
        for (;;) {
          const item = await q2.checkout();
          if (!item) break;
          drained.push(item.itemUrl);
          await q2.markDone(item);
        }

        const final = await q2.snapshot();

        return {
          inFlightThird: third?.itemUrl,
          inFlightCount: inFlightSnapshot.filter((i) => i.status === 'in-flight').length,
          postReviveInFlight: postReviveSnapshot.filter((i) => i.status === 'in-flight').length,
          postRevivePending: postReviveSnapshot
            .filter((i) => i.status === 'pending')
            .map((i) => i.itemUrl)
            .sort(),
          drained: drained.sort(),
          finalDone: final.filter((i) => i.status === 'done').length,
        };
      });

      expect(result.inFlightThird).toBe('/c');
      expect(result.inFlightCount).toBe(1);
      // After revive, the in-flight one bounces back to pending.
      expect(result.postReviveInFlight).toBe(0);
      expect(result.postRevivePending).toEqual(['/c', '/d', '/e']);
      // Drain processes /c, /d, /e in some order.
      expect(result.drained).toEqual(['/c', '/d', '/e']);
      // All 5 items end up done.
      expect(result.finalDone).toBe(5);
    } finally {
      await browser.close();
    }
  });

  test('dedup on enqueue — re-enqueueing same key is a no-op', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const io = nf.memoryQueueIO();
        const q = new nf.PersistentQueue(io, () => 1);
        await q.enqueue([{ fingerprint: 'fp', itemUrl: '/a' }]);
        await q.enqueue([{ fingerprint: 'fp', itemUrl: '/a' }]);
        await q.enqueue([
          { fingerprint: 'fp', itemUrl: '/a' },
          { fingerprint: 'fp', itemUrl: '/b' },
        ]);
        return (await q.snapshot()).length;
      });
      expect(result).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('markFailed bounces back to pending until attempts ≥ MAX', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const io = nf.memoryQueueIO();
        const q = new nf.PersistentQueue(io, () => 1);
        await q.enqueue([{ fingerprint: 'fp', itemUrl: '/x' }]);
        const trace: string[] = [];
        for (let i = 0; i < 4; i++) {
          const item = await q.checkout();
          if (!item) {
            trace.push('empty');
            break;
          }
          await q.markFailed(item, `attempt-${i + 1}`);
          const snap = await q.snapshot();
          trace.push(snap[0]?.status ?? 'gone');
        }
        return trace;
      });
      // attempts: 1→pending, 2→pending, 3→failed (>= MAX_ATTEMPTS),
      // 4th checkout returns null.
      expect(result).toEqual(['pending', 'pending', 'failed', 'empty']);
    } finally {
      await browser.close();
    }
  });
});
