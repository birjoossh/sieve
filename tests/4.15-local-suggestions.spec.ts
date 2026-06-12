// 4.15 — local phrase suggestions (user bug #1: "suggested phrases should be
// from the current page contents", feedback round 2: "rank by top recurring
// tokens — the first cut read as random").
//
// The content script extracts candidate phrases from the detected items
// (content/suggest.ts) and replies over getSuggestions/suggestions — zero
// network, works with no API key, inherently page-relevant. Ranking is
// top-recurring-first: docCount desc within a [15%, 90%] band (floor min 2),
// so chrome on every card stays out while genuinely frequent topics lead.
// With an LLM key the panel sends these candidates (only the candidates —
// PRIVACY.md) to the provider for curation, falling back to the local list
// on any failure.
//
// Three layers:
//   (a) Engine — suggestFromItems via the testbed on the rolecast fixture +
//       a synthetic DOM exercising the chrome ceiling, recurrence ordering,
//       bigram redundancy, detailText folding, and the max cap.
//   (b) Panel UI, no key — click ✦ → page-derived pills → Accept.
//   (c) Panel UI, key + unreachable endpoint — curation fails, local
//       candidates still render (the fallback contract).

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

// A handful of stopwords that DO occur in the rolecast card text — none may
// surface as a suggestion (unigram or bigram component).
const STOPWORD_SAMPLE = ['the', 'and', 'for', 'with', 'our', 'this', 'that', 'only'];

test.describe('4.15 — local suggestions (engine layer)', () => {
  test('suggestFromItems on rolecast: page-derived, no stopwords, recurrence band, deterministic', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const items = [...document.querySelectorAll('.joblist > .job')];
        const first = nf.suggestFromItems(items, undefined, []);
        const second = nf.suggestFromItems(items, undefined, []);
        const withExisting = nf.suggestFromItems(items, undefined, ['mandarin', 'Remote']);
        // Per-suggestion document frequency by substring, for the band
        // assertion (15% ≤ df ≤ 90% of cards, floor min 2).
        const df = first.map(
          (s) =>
            items.filter((el) =>
              (el.textContent ?? '').toLowerCase().includes(s.toLowerCase()),
            ).length,
        );
        return { first, second, withExisting, df, itemCount: items.length };
      });

      // Page-derived + original casing: "Mandarin" sits in 3 of 10 cards and
      // is always capitalized in the fixture.
      expect(result.first).toContain('Mandarin');
      expect(result.first).not.toContain('mandarin');

      // Deterministic across calls.
      expect(result.second).toEqual(result.first);

      // Max respected (default 8).
      expect(result.first.length).toBeLessThanOrEqual(8);
      expect(result.first.length).toBeGreaterThan(0);

      // No stopwords — neither as a suggestion nor inside a bigram.
      for (const s of result.first) {
        for (const word of s.toLowerCase().split(' ')) {
          expect(STOPWORD_SAMPLE).not.toContain(word);
        }
      }

      // Recurrence band: every suggestion present in ≥ max(2, 15%) of cards
      // and at most 90% of them (near-universal text is layout chrome).
      const floor = Math.max(2, Math.ceil(result.itemCount * 0.15));
      const ceiling = Math.floor(result.itemCount * 0.9);
      for (const n of result.df) {
        expect(n).toBeGreaterThanOrEqual(floor);
        expect(n).toBeLessThanOrEqual(ceiling);
      }

      // `existing` excluded case-insensitively.
      const lowered = result.withExisting.map((s) => s.toLowerCase());
      expect(lowered).not.toContain('mandarin');
      expect(lowered).not.toContain('remote');
    } finally {
      await browser.close();
    }
  });

  test('top-recurring ordering, chrome ceiling, bigram redundancy, detailText, max cap', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const texts = [
          'PromoChip golang remote crypto',
          'PromoChip golang remote crypto',
          'PromoChip golang onsite crypto',
          'PromoChip golang onsite',
          'PromoChip rust remote',
          'PromoChip java',
        ];
        const items = texts.map((t) => {
          const el = document.createElement('div');
          el.textContent = t;
          return el;
        });
        const plain = nf.suggestFromItems(items, undefined, []);
        const detail = new Map<Element, string>([
          [items[0]!, 'kubernetes pipeline'],
          [items[1]!, 'kubernetes pipeline'],
        ]);
        const withDetail = nf.suggestFromItems(items, detail, []);
        const capped = nf.suggestFromItems(items, undefined, [], 2);
        return { plain, withDetail, capped };
      });

      // Top-recurring tokens lead, in descending document frequency:
      // golang (4) > crypto (3) > remote (3, fewer total) > onsite (2).
      // "PromoChip" is on 6/6 — above the 90% ceiling, layout chrome.
      // "java" / "rust" are on 1 card — below the floor of 2.
      // Bigrams like "golang remote" share a word with a selected unigram
      // and never spend a slot.
      expect(result.plain).toEqual(['golang', 'crypto', 'remote', 'onsite']);
      // detailText is folded into the per-item corpus.
      expect(result.withDetail).toContain('kubernetes');
      // Explicit max cap keeps the top of the same ordering.
      expect(result.capped).toEqual(['golang', 'crypto']);
    } finally {
      await browser.close();
    }
  });
});

test.describe('4.15 — local suggestions (UI layer, no LLM key)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
    // Deliberately NO LLM key in storage — local suggestions must not
    // require one.
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('click ✦ with no key → page-derived pills → Accept adds chip + engine re-evaluates', async () => {
    // Initial state: 0 slivers, 0 chips, no suggest list, no key configured.
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
    await expect(env.panel.locator('.chip')).toHaveCount(0);
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(0);

    // Click ✦ → suggestions extracted from the rolecast cards appear.
    await env.panel.click('button[data-action="suggest-phrases"]');
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(1);
    await expect(env.panel.locator('[data-role="suggest-error"]')).toHaveCount(0);
    const pills = env.panel.locator('.suggest-pill');
    expect(await pills.count()).toBeGreaterThan(0);
    expect(await pills.count()).toBeLessThanOrEqual(8);
    // "Mandarin" (3 of 10 cards, capitalized on the page) must be offered.
    await expect(env.panel.locator('.suggest-pill[data-suggestion="Mandarin"]')).toHaveCount(1);

    // Accept it → chip appears, pill goes away, 3 Mandarin cards collapse.
    await env.panel.click('button[data-action="accept-suggestion"][data-suggestion="Mandarin"]');
    await expect(env.panel.locator('.chip[data-phrase="Mandarin"]')).toHaveCount(1);
    await expect(env.panel.locator('.suggest-pill[data-suggestion="Mandarin"]')).toHaveCount(0);
    await expect(env.fixture.locator('.sliver')).toHaveCount(3);

    // Dismiss the rest.
    await env.panel.click('button[data-action="dismiss-suggestions"]');
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(0);

    // Cleanup for any follow-on test.
    await env.panel.click('.chip[data-phrase="Mandarin"] .chip-remove');
    await expect(env.fixture.locator('.sliver')).toHaveCount(0);
  });
});

test.describe('4.15 — LLM curation fallback (key set, endpoint unreachable)', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
    // A key IS configured but the endpoint can't be reached — curation
    // must fail soft and the local candidates must still render.
    await env.panel.evaluate(() =>
      chrome.storage.local.set({
        'nf:llm-settings': {
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'http://127.0.0.1:9/unreachable',
        },
      }),
    );
    // Re-pull settings into panel state.
    await env.panel.reload();
    await env.fixture.bringToFront();
    await env.panel.waitForFunction(
      () => document.querySelector('[data-role="page-detected"]') !== null,
      undefined,
      { timeout: 5_000 },
    );
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('click ✦ with broken endpoint → local suggestions still appear', async () => {
    await env.panel.click('button[data-action="suggest-phrases"]');
    await expect(env.panel.locator('[data-role="suggest-list"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    const pills = env.panel.locator('.suggest-pill');
    expect(await pills.count()).toBeGreaterThan(0);
    await expect(env.panel.locator('.suggest-pill[data-suggestion="Mandarin"]')).toHaveCount(1);
  });
});
