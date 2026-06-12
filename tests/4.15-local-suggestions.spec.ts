// 4.15 — local phrase suggestions (user bug #1: "suggested phrases should be
// from the current page contents").
//
// The panel's ✦ button no longer calls the LLM. The content script extracts
// candidate phrases from the detected items themselves (content/suggest.ts)
// and replies over the new getSuggestions/suggestions message pair — zero
// network, works with no API key, inherently page-relevant.
//
// Two layers:
//   (a) Engine — suggestFromItems via the testbed on the rolecast fixture +
//       a synthetic DOM that exercises the chrome ceiling, detailText
//       folding, and the max cap.
//   (b) Panel UI — real extension, NO LLM key configured: click ✦ →
//       page-derived pills render → Accept moves one to chips and the
//       engine re-evaluates.

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
  test('suggestFromItems on rolecast: page-derived, no stopwords, discriminative, deterministic', async () => {
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
        // Per-suggestion document frequency by substring, for the
        // discriminative-band assertion (2 ≤ df ≤ 60% of cards).
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

      // Discriminative band: every suggestion present in ≥2 cards and in at
      // most 60% of them.
      const ceiling = Math.floor(result.itemCount * 0.6);
      for (const n of result.df) {
        expect(n).toBeGreaterThanOrEqual(2);
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

  test('layout chrome ceiling, detailText folding, max cap (synthetic DOM)', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const result = await page.evaluate(() => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        const texts = [
          'PromoChip remote rust',
          'PromoChip remote rust',
          'PromoChip remote golang',
          'PromoChip onsite golang',
          'PromoChip onsite java',
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

      // "PromoChip" is in 5/5 items — layout chrome, above the 60% ceiling.
      expect(result.plain).not.toContain('PromoChip');
      // "rust" is in 2/5 — discriminative content.
      expect(result.plain).toContain('rust');
      // "java" is in 1/5 — below the 2-item floor.
      expect(result.plain).not.toContain('java');
      // detailText is folded into the per-item corpus.
      expect(result.withDetail).toContain('kubernetes');
      // Explicit max cap.
      expect(result.capped).toHaveLength(2);
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
