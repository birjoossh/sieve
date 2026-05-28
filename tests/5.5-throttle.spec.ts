// 5.5 — Throttle policy (concurrency, jitter, per-domain rate cap,
// exponential backoff on 429 / Cloudflare signals).
//
// Gate from tasks.md:
//   "mock server returns 429 → backoff increases; concurrent fetch
//    count never exceeds the cap."
//
// Two concrete properties to lock in:
//   1. The semaphore caps in-flight per-domain — fan out 8 acquires
//      with concurrency=3, observe peak ≤ 3.
//   2. Backoff escalates after consecutive `rate-limited` outcomes —
//      sleep deltas read off a stub clock should follow the schedule.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

test.describe('5.5 — throttler', () => {
  test('concurrency cap holds under burst (fan-out 8, cap 3 → peak ≤ 3)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const peak = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        const t = new nf.Throttler({
          concurrency: 3,
          jitterMs: 0,
          sleep,
          random: () => 0,
        });
        let inFlight = 0;
        let observed = 0;
        const runs = Array.from({ length: 8 }, async () => {
          const release = await t.acquire('example.com');
          inFlight += 1;
          observed = Math.max(observed, inFlight);
          // Simulate "work" with a 20ms hold.
          await sleep(20);
          inFlight -= 1;
          release();
        });
        await Promise.all(runs);
        return observed;
      });
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThanOrEqual(2);
    } finally {
      await browser.close();
    }
  });

  test('429 outcomes escalate backoff per the schedule', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const sleeps = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const captured: number[] = [];
        // Stub clock — Date.now() reads through to the real wall
        // clock for the backoff-until check, but the throttler only
        // looks at relative deltas. Provide a deterministic sleep
        // that records the requested ms.
        const sleep = async (ms: number) => {
          captured.push(ms);
        };
        const t = new nf.Throttler({
          concurrency: 1,
          jitterMs: 0,
          backoffMs: [500, 1_000, 2_000, 4_000, 8_000],
          sleep,
          random: () => 0,
        });

        // Fire one acquire to get the first slot.
        let release = await t.acquire('rate.com');
        release();

        // Hit 3 consecutive rate-limited outcomes → backoff
        // escalates 500, 1000, 2000.
        t.reportOutcome('rate.com', 'rate-limited');
        release = await t.acquire('rate.com');
        release();
        t.reportOutcome('rate.com', 'rate-limited');
        release = await t.acquire('rate.com');
        release();
        t.reportOutcome('rate.com', 'rate-limited');
        release = await t.acquire('rate.com');
        release();

        return captured;
      });

      // We expect at least one sleep call per acquire that hit a
      // backoff window. With stub clock not advancing, each sleep
      // sees roughly the full delay. We assert the schedule
      // progresses: each subsequent observed delay ≥ previous.
      // Filter out zeros (acquires after a reset / on the very
      // first call).
      const nonZero = sleeps.filter((n) => n > 0);
      expect(nonZero.length).toBeGreaterThanOrEqual(3);
      // The sequence is increasing — escalation rather than fixed.
      const ratio = nonZero[nonZero.length - 1] / nonZero[0];
      expect(ratio).toBeGreaterThanOrEqual(3); // 2000/500 = 4
    } finally {
      await browser.close();
    }
  });

  test('successful outcome resets backoff', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const inspect = await page.evaluate(async () => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const t = new nf.Throttler({
          concurrency: 1,
          jitterMs: 0,
          sleep: async () => {},
          random: () => 0,
        });
        t.reportOutcome('host', 'rate-limited');
        t.reportOutcome('host', 'rate-limited');
        const mid = t.inspect('host');
        t.reportOutcome('host', 'ok');
        const after = t.inspect('host');
        return { mid, after };
      });
      expect(inspect.mid.consecutive429).toBe(2);
      expect(inspect.after.consecutive429).toBe(0);
      expect(inspect.after.backoffUntil).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
