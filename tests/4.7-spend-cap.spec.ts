// 4.7 — Real spend cap (per-day + per-month), background/spend.ts.
//
// Gate from tasks.md:
//   "simulate spend over cap → next LLM call blocked with reason
//    'spend-cap-reached'; UI shows it."
//
// Two layers:
//   (a) Engine layer — discoverSchema enforces the cap via opts.spend.
//       Pre-seed an in-memory checker over the cap, call discover,
//       expect SpendCapError (reason 'spend-cap-reached', period
//       'day' / 'month'). Clean ledger → schema returned + spend
//       recorded.
//   (b) UI layer — the panel's LLM settings section surfaces a
//       "cap reached" warning when storage.local says the ledger
//       is over the daily cap.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupExtEnv, type ExtEnv } from './testbed/ext-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const VALID_SCHEMA = JSON.stringify({
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > .job',
  fields: { title: { kind: 'text', selector: '.title' } },
});

test.describe('4.7 — spend cap (engine layer)', () => {
  test('discoverSchema throws SpendCapError when ledger is over the daily cap', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async (validSchemaJson) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        // Mock fetcher — would succeed if called.
        const fetcher = async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: validSchemaJson }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });

        // Pre-seed ledger at the daily cap → first call blocks. Epochs use
        // the ledger's LOCAL-calendar indices (rollover happens at the
        // user's midnight, not UTC's).
        const now = Date.UTC(2026, 4, 25, 12, 0, 0);
        const localDay = Math.floor(
          (now - new Date(now).getTimezoneOffset() * 60_000) / (24 * 60 * 60 * 1000),
        );
        const localMonth = new Date(now).getFullYear() * 12 + new Date(now).getMonth();
        const overDay = nf.memorySpendChecker(
          {
            dailyEpoch: localDay,
            dailyCount: 50,
            monthlyEpoch: localMonth,
            monthlyCount: 60,
          },
          { daily: 50, monthly: 1000 },
        );

        let caught: { name: string; reason?: string; period?: string } | null = null;
        try {
          await nf.discoverSchema('<root>…</root>', {
            provider: 'anthropic',
            apiKey: 'sk-test',
            fingerprint: 'fixture:rolecast:v1',
            fetcher,
            now: () => now,
            spend: overDay,
          });
        } catch (err) {
          if (err instanceof nf.SpendCapError) {
            caught = { name: err.name, reason: err.reason, period: err.period };
          } else if (err instanceof Error) {
            caught = { name: err.name };
          }
        }
        return caught;
      }, VALID_SCHEMA);

      expect(result).toEqual({ name: 'SpendCapError', reason: 'spend-cap-reached', period: 'day' });
    } finally {
      await browser.close();
    }
  });

  test('clean ledger → discoverSchema succeeds + recordSpend fires once', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async (validSchemaJson) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const fetcher = async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: validSchemaJson }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });

        let recordCalls = 0;
        const now = Date.UTC(2026, 4, 25, 12, 0, 0);
        const checker = {
          async canSpend() {
            return { ok: true } as const;
          },
          async recordSpend() {
            recordCalls += 1;
          },
        };

        const schema = await nf.discoverSchema('<root>…</root>', {
          provider: 'anthropic',
          apiKey: 'sk-test',
          fingerprint: 'fixture:rolecast:v1',
          fetcher,
          now: () => now,
          spend: checker,
        });

        return { hasSchema: schema.layout === 'list', recordCalls };
      }, VALID_SCHEMA);

      expect(result).toEqual({ hasSchema: true, recordCalls: 1 });
    } finally {
      await browser.close();
    }
  });

  test('monthly cap is independent of daily cap', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(async (validSchemaJson) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const fetcher = async () =>
          new Response(JSON.stringify({ content: [{ type: 'text', text: validSchemaJson }] }), {
            status: 200,
          });

        const now = Date.UTC(2026, 4, 25, 12, 0, 0);
        // Daily under cap, monthly over cap → blocks with period=month.
        // Local-calendar epochs to match the ledger's rollover indices.
        const localDay = Math.floor(
          (now - new Date(now).getTimezoneOffset() * 60_000) / (24 * 60 * 60 * 1000),
        );
        const localMonth = new Date(now).getFullYear() * 12 + new Date(now).getMonth();
        const overMonth = nf.memorySpendChecker(
          {
            dailyEpoch: localDay,
            dailyCount: 10,
            monthlyEpoch: localMonth,
            monthlyCount: 1000,
          },
          { daily: 50, monthly: 1000 },
        );

        let caught: { period?: string } | null = null;
        try {
          await nf.discoverSchema('<root>…</root>', {
            provider: 'anthropic',
            apiKey: 'sk-test',
            fingerprint: 'fixture:rolecast:v1',
            fetcher,
            now: () => now,
            spend: overMonth,
          });
        } catch (err) {
          if (err instanceof nf.SpendCapError) caught = { period: err.period };
        }
        return caught;
      }, VALID_SCHEMA);

      expect(result).toEqual({ period: 'month' });
    } finally {
      await browser.close();
    }
  });
});

test.describe('4.7 — spend cap (UI layer)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('panel surfaces cap-reached warning when storage.local says ledger is over cap', async () => {
    // Pre-seed chrome.storage.local in the panel context, then reload
    // the panel page → refresh() reads the ledger via getSpendStatus()
    // → llm-settings component renders the warning.
    await env.panel.evaluate(async () => {
      const now = Date.now();
      const today = Math.floor(
        (now - new Date(now).getTimezoneOffset() * 60_000) / (24 * 60 * 60 * 1000),
      );
      const d = new Date(now);
      const month = d.getFullYear() * 12 + d.getMonth();
      await chrome.storage.local.set({
        'nf:spend-ledger': {
          dailyEpoch: today,
          dailyCount: 100,
          monthlyEpoch: month,
          monthlyCount: 200,
        },
        // The usage meter only renders when a provider key is configured.
        'nf:llm-settings': { provider: 'anthropic', apiKey: 'sk-test-spend-cap' },
      });
    });

    await env.panel.reload();

    // Usage readout + warning both present.
    await expect(env.panel.locator('[data-role="spend-usage"]')).toContainText('100 / 50 today');
    await expect(env.panel.locator('[data-role="spend-cap-warning"]')).toContainText(
      'Daily spend cap reached',
    );
  });
});
