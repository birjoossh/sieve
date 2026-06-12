// 4.10 — LinkedIn /jobs/collections/recommended END-TO-END against the LIVE
// site. Drives the user-reported scenario step-by-step on linkedin.com so we
// can see what actually breaks in production (the synthetic LazyColumn
// fixture passed, but the user still saw the bug manually — see notes
// below).
//
// PREREQ — auth. LinkedIn refuses headless / fresh-profile traffic, so we
// reuse a Chrome user-data dir the user has already logged in to:
//
//   1) Pick a stable path, e.g. ~/.cache/nf-tests/linkedin-userdata
//   2) Bootstrap it once interactively:
//        npx playwright install chromium  # if you haven't
//        node -e "import('playwright').then(({chromium}) => \
//          chromium.launchPersistentContext('<that-path>', { headless: false, channel: 'chromium' }))"
//      A browser window opens. Log in to LinkedIn manually, close the
//      window. Cookies + storage persist in the dir.
//   3) Export the env var before running the spec:
//        export NF_LINKEDIN_USER_DATA=<that-path>
//        npm run build && npx playwright test tests/4.10-linkedin-recommended-scenario.spec.ts --headed
//
// The test is skipped without the env var — keep CI green and don't lie
// about coverage.
//
// What this spec proves about the bug surface:
//   - The synthetic LazyColumn fixture in earlier 4.10 cards were direct
//     children of `[componentkey="SearchResultsMainContent"]`. The
//     production tree is virtualized, so real cards live inside extra
//     wrappers. The MutationWatcher (extension/content/mutations.ts:54)
//     observes the itemSet with `childList` only (no `subtree`) and only
//     accepts addedNodes that themselves match the schema's itemSelector.
//     So on a real same-origin search-submit, post-navigation cards may
//     never reach onItemsAdded — and the panel-side preservation we
//     wrote in 4.9 isn't enough on its own. Running this against the
//     real site is how we find out.
//
// Assertions are deliberately structural ("at least one hidden, no visible
// card contains 'Lead'") rather than exact counts — LinkedIn's recommended
// feed is per-user and time-varying.

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_DIST = resolve(__dirname, '..', 'dist');

const LINKEDIN_USER_DATA = process.env['NF_LINKEDIN_USER_DATA'];

// No pinned currentJobId: job ids go stale within days and LinkedIn then
// answers the URL with an HTTP error (seen 2026-06-11). The site auto-adds
// currentJobId + renders the dual-pane layout on its own (memory.md
// 2026-06-05).
const RECOMMENDED_URL = 'https://www.linkedin.com/jobs/collections/recommended/';

// LinkedIn ships two parallel layouts (see memory.md 2026-06-05) and which
// one any given URL serves depends on user, A/B bucket, and time. We pick
// whichever stub fires at runtime rather than hardcoding one.
//
//   v1 (legacy)   — `ul:has(> li.scaffold-layout__list-item)`, items
//                   `li.scaffold-layout__list-item`, fingerprint
//                   `site:linkedin:jobs:v1`.
//   v2 (LazyColumn) — `[componentkey="SearchResultsMainContent"]`, items
//                   `[role="button"][componentkey^="job-card-component-ref-"]`,
//                   fingerprint `site:linkedin:jobs:v2`.
//
// The container that holds either kind of card (used for visibility audits).
const ANY_CARD_SELECTOR =
  'li.scaffold-layout__list-item, [role="button"][componentkey^="job-card-component-ref-"]';
const ACCEPTED_FINGERPRINTS = new Set(['site:linkedin:jobs:v1', 'site:linkedin:jobs:v2']);

async function buildTestExtension(): Promise<string> {
  // Same trick as testbed/ext-env.ts: copy dist + bake <all_urls> so the
  // first-run permission prompt doesn't deadlock the test. linkedin.com is
  // covered by <all_urls>, so no extra grant is needed.
  const dir = await mkdtemp(join(tmpdir(), 'nf-linkedin-test-'));
  await cp(PROD_DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['host_permissions'] = ['<all_urls>'];
  delete manifest['optional_host_permissions'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

interface PanelStateSnapshot {
  fingerprint: string | null;
  source: string | null;
  filterPhrases: string[];
  itemsTotal: number;
  itemsFiltered: number;
}

/** Wait until at least one item enters `filtered` state — guards the
 *  audits against racing LinkedIn's lazy content hydration. Returns the
 *  final snapshot. */
async function waitForFilterToSettle(
  panel: Page,
  expectAtLeastOneFiltered: boolean,
  timeoutMs = 10_000,
): Promise<PanelStateSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  let last: PanelStateSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await readPanelState(panel);
    if (!expectAtLeastOneFiltered) return last;
    if (last && last.itemsFiltered > 0) return last;
    await panel.waitForTimeout(250);
  }
  return last;
}

/** Probe state via the content/panel bus from inside the panel page. */
function readPanelState(panel: Page): Promise<PanelStateSnapshot | null> {
  return panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return null;
    const reply = (await chrome.tabs.sendMessage(tabId, {
      t: 'getState',
      v: 1,
    })) as {
      state?: {
        schema?: { fingerprint?: string; source?: string };
        filters?: Array<{ predicate?: { op?: string; phrases?: string[] } }>;
        items?: Array<{ state?: string }>;
      };
    };
    const filterPhrases: string[] = [];
    for (const f of reply?.state?.filters ?? []) {
      if (f.predicate?.op === 'containsAny' && Array.isArray(f.predicate.phrases)) {
        for (const p of f.predicate.phrases) filterPhrases.push(p);
      }
    }
    const items = reply?.state?.items ?? [];
    return {
      fingerprint: reply?.state?.schema?.fingerprint ?? null,
      source: reply?.state?.schema?.source ?? null,
      filterPhrases,
      itemsTotal: items.length,
      itemsFiltered: items.filter((i) => i.state === 'filtered').length,
    };
  });
}

/** Card-text audit run from inside the LinkedIn page. Returns identifiers
 *  of visible cards whose textContent contains `phrase` (case-insensitive).
 *  "Hidden" covers both render modes: wrapped in `.filt` (wrap mode) or
 *  collapsed in place via `.nf-filt-item` (detached mode — the v2
 *  LazyColumn stub). A non-empty list = filter failed to hide matching
 *  cards. */
async function auditVisibleCardsForPhrase(
  linkedin: Page,
  phrase: string,
): Promise<{ totalCards: number; hiddenCount: number; leakedIds: string[] }> {
  return linkedin.evaluate(
    ({ phrase, itemSelector }) => {
      const cards = Array.from(document.querySelectorAll(itemSelector));
      const lower = phrase.toLowerCase();
      const visibleCards = cards.filter(
        (c) => !c.closest('.filt') && !c.closest('.nf-filt-item:not(.nf-restored)'),
      );
      const idOf = (c: Element): string =>
        c.getAttribute('componentkey') ??
        c.getAttribute('data-occludable-job-id') ??
        c.getAttribute('data-job-id') ??
        '(no-id)';
      const leaks = visibleCards
        .filter((c) => (c.textContent ?? '').toLowerCase().includes(lower))
        .map(idOf);
      return {
        totalCards: cards.length,
        hiddenCount: cards.length - visibleCards.length,
        leakedIds: leaks,
      };
    },
    { phrase, itemSelector: ANY_CARD_SELECTOR },
  );
}

test.describe('4.10 — LinkedIn /jobs/collections/recommended (live)', () => {
  test.skip(
    !LINKEDIN_USER_DATA,
    'Set NF_LINKEDIN_USER_DATA to a Chrome user-data dir that has an authenticated LinkedIn session. ' +
      'See the comment block at the top of this spec for the one-time bootstrap.',
  );

  // The live site is slow — give the whole test 3 minutes.
  test.setTimeout(180_000);

  let extDir = '';
  let context: BrowserContext | null = null;

  test.afterAll(async () => {
    await context?.close().catch(() => undefined);
    if (extDir) rmSync(extDir, { recursive: true, force: true });
  });

  test('apply Lead → search Tech Lead → filter persists → add Mandarin', async () => {
    extDir = await buildTestExtension();

    // Headed because LinkedIn fingerprints headless. The user runs this
    // locally, not in CI.
    context = await chromium.launchPersistentContext(LINKEDIN_USER_DATA as string, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-sandbox',
      ],
      viewport: { width: 1400, height: 900 },
    });

    const sw =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extId = new URL(sw.url()).host;

    // -----------------------------------------------------------------
    // Step 1: open the recommended-jobs URL on the real site.
    // -----------------------------------------------------------------
    const linkedin = await context.newPage();
    await linkedin.goto(RECOMMENDED_URL, { waitUntil: 'domcontentloaded' });

    // Auth sanity: a logged-out session bounces to /login or /authwall.
    const landed = linkedin.url();
    if (/\/login|\/authwall|\/uas|\/checkpoint/.test(landed)) {
      throw new Error(
        `LinkedIn redirected to ${landed} — auth state expired. ` +
          'Re-bootstrap the userdata dir by logging in manually.',
      );
    }

    // Wait for the recommended-feed cards to render. LinkedIn streams
    // them in; the LazyColumn container shows up first, cards seconds
    // later. 30s budget covers slow networks.
    await linkedin.waitForSelector(ANY_CARD_SELECTOR, { timeout: 30_000 });
    const initialCardCount = await linkedin.locator(ANY_CARD_SELECTOR).count();
    expect(initialCardCount).toBeGreaterThan(0);

    // -----------------------------------------------------------------
    // Open the extension panel and enable on linkedin.com.
    // -----------------------------------------------------------------
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await linkedin.bringToFront();
    await panel.waitForFunction(
      () => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-action="enable-site"]',
        );
        return (btn?.textContent ?? '').includes('linkedin.com');
      },
      undefined,
      { timeout: 10_000 },
    );
    await panel.click('button[data-action="enable-site"]');

    // Permission grant is auto-accepted because the test extension's
    // manifest already declares <all_urls>. Reload the tab so the content
    // script actually injects on this navigation (production UX prompts
    // the user to refresh).
    await linkedin.reload({ waitUntil: 'domcontentloaded' });
    await linkedin.waitForSelector(ANY_CARD_SELECTOR, { timeout: 30_000 });

    // Wait for the LinkedIn stub to mount via the panel→content getState
    // round-trip. We poll a few times because LinkedIn hydrates the
    // LazyColumn well after document_idle.
    let state = await readPanelState(panel);
    for (
      let i = 0;
      i < 30 && !(state?.fingerprint && ACCEPTED_FINGERPRINTS.has(state.fingerprint));
      i++
    ) {
      await panel.waitForTimeout(500);
      state = await readPanelState(panel);
    }
    expect(
      state?.fingerprint,
      'LinkedIn stub did not fire — pickStubSchema may have changed or the page now uses a 3rd layout',
    ).toBeTruthy();
    expect(
      ACCEPTED_FINGERPRINTS.has(state?.fingerprint ?? ''),
      `Unexpected fingerprint ${state?.fingerprint}`,
    ).toBe(true);
    expect(state?.source).toBe('stub');
    test
      .info()
      .annotations.push({ type: 'layout', description: state?.fingerprint ?? '<none>' });

    // -----------------------------------------------------------------
    // Step 2 + 3: apply "Lead". Recommended feeds vary per user; assert
    // that AT LEAST ONE card is hidden and that NO VISIBLE card's text
    // contains "lead" (case-insensitive). The leaked-card list is what
    // diagnoses failures.
    // -----------------------------------------------------------------
    await panel.fill('input[data-input="phrase"]', 'Lead');
    await panel.click('button.phrase-add');
    await panel.waitForFunction(
      () => document.querySelector('.chip[data-phrase="Lead"]') !== null,
      undefined,
      { timeout: 5_000 },
    );

    // Wait for content's engine to actually run AND for the renderer to
    // paint at least one `.filt`. 500ms-flat raced LinkedIn's lazy text
    // hydration in the first attempt.
    const settled1 = await waitForFilterToSettle(panel, true, 15_000);
    test
      .info()
      .annotations.push({ type: 'settled1', description: JSON.stringify(settled1) });

    const phase1 = await auditVisibleCardsForPhrase(linkedin, 'Lead');
    test
      .info()
      .annotations.push({ type: 'phase1', description: JSON.stringify(phase1) });
    expect(
      phase1.hiddenCount,
      `Expected at least 1 card hidden after applying "Lead" — recommended feed: ${phase1.totalCards} cards`,
    ).toBeGreaterThan(0);
    expect(
      phase1.leakedIds,
      `Visible cards still containing "Lead" after filter: ${phase1.leakedIds.join(', ')}`,
    ).toHaveLength(0);

    // -----------------------------------------------------------------
    // Step 4: "Search Tech Lead". Type into LinkedIn's jobs search box
    // and submit. LinkedIn's keyword input varies (legacy/new layout);
    // we try a couple of selectors and fall back to a direct URL
    // navigation so we still exercise the post-navigation state
    // preservation even if the search box selector drifts.
    // -----------------------------------------------------------------
    const searchSubmitted = await (async (): Promise<boolean> => {
      const candidates = [
        'input[role="combobox"][aria-label*="job" i]',
        'input[role="combobox"][placeholder*="job" i]',
        'input[id*="keyword" i]',
        'input[aria-label*="Search jobs" i]',
      ];
      for (const sel of candidates) {
        const input = linkedin.locator(sel).first();
        if ((await input.count()) === 0) continue;
        try {
          await input.click({ timeout: 3_000 });
          await input.fill('Tech Lead');
          await input.press('Enter');
          await linkedin.waitForLoadState('domcontentloaded', { timeout: 15_000 });
          return true;
        } catch {
          continue;
        }
      }
      return false;
    })();

    if (!searchSubmitted) {
      // Fallback: go straight to /jobs/search-results/ with the keyword.
      // Same origin, same fingerprint, exercises identical code path.
      await linkedin.goto(
        'https://www.linkedin.com/jobs/search-results/?keywords=Tech%20Lead',
        { waitUntil: 'domcontentloaded' },
      );
    }
    await linkedin.waitForSelector(ANY_CARD_SELECTOR, { timeout: 30_000 });
    // Wait for the new card set to settle (LinkedIn streams them in).
    await linkedin.waitForTimeout(2_500);

    // -----------------------------------------------------------------
    // Step 5: existing filter must auto-apply. If we have an open bug
    // here it'll show as either (a) chip vanished — panel preservation
    // failed; or (b) chip present but visible cards still contain "Lead"
    // — content side missed the new cards (MutationWatcher subtree gap).
    // The assertion below diagnoses BOTH.
    // -----------------------------------------------------------------
    await panel.waitForFunction(
      () => document.querySelector('.chip[data-phrase="Lead"]') !== null,
      undefined,
      { timeout: 10_000 },
    );
    await expect(panel.locator('.chip[data-phrase="Lead"]')).toHaveCount(1);

    // Wait for the post-navigation re-evaluation to fire + paint.
    const settled2 = await waitForFilterToSettle(panel, true, 15_000);
    test
      .info()
      .annotations.push({ type: 'settled2', description: JSON.stringify(settled2) });

    const phase2 = await auditVisibleCardsForPhrase(linkedin, 'Lead');
    const domFiltCount2 = await linkedin
      .locator('.filt')
      .count()
      .catch(() => 0);
    const domDetachedCount2 = await linkedin
      .locator('.nf-filt-item')
      .count()
      .catch(() => 0);
    test
      .info()
      .annotations.push({ type: 'phase2', description: JSON.stringify(phase2) });
    test.info().annotations.push({
      type: 'phase2-dom',
      description: `domFilt=${domFiltCount2} domDetached=${domDetachedCount2}`,
    });

    // Two failure modes to disambiguate:
    //   (A) settled2.itemsFiltered === 0 — engine didn't see any matching
    //       items. ctx.filters lost or ctx.items missing the new cards
    //       (preservation failed or mutation-watcher missed the new
    //       subtree).
    //   (B) settled2.itemsFiltered > 0 but the DOM carries neither `.filt`
    //       wrappers (wrap mode) nor `.nf-filt-item` collapses (detached
    //       mode, the 6.7 fix for the v2 LazyColumn reconciler) — the
    //       engine evaluated correctly but the renderer's output didn't
    //       survive in the DOM.
    const engineFiltered = settled2?.itemsFiltered ?? 0;
    if (engineFiltered === 0) {
      expect(
        engineFiltered,
        `Engine reports 0 filtered after navigation — filter or items lost. ` +
          `state=${JSON.stringify(settled2)}`,
      ).toBeGreaterThan(0);
    }
    expect(
      domFiltCount2 + domDetachedCount2,
      `Engine reports ${engineFiltered} filtered but DOM has neither .filt ` +
        `wrappers nor .nf-filt-item collapses. The renderer's output is being ` +
        `reverted by LinkedIn's React reconciler and the detached fallback ` +
        `did not engage.`,
    ).toBeGreaterThan(0);
    expect(
      phase2.leakedIds,
      `Post-search visible cards still containing "Lead": ${phase2.leakedIds.join(', ')}`,
    ).toHaveLength(0);

    // -----------------------------------------------------------------
    // Step 6 + 7: add "Mandarin". Recommended/search results may not
    // include Mandarin matches — so the assertion is "no visible card
    // contains Mandarin". Hidden count may legitimately be 0 if no card
    // mentions Mandarin; that's not a bug.
    // -----------------------------------------------------------------
    await panel.fill('input[data-input="phrase"]', 'Mandarin');
    await panel.click('button.phrase-add');
    await panel.waitForFunction(
      () => document.querySelector('.chip[data-phrase="Mandarin"]') !== null,
      undefined,
      { timeout: 5_000 },
    );
    // Mandarin may legitimately match 0 cards — don't require ≥1 filtered.
    await waitForFilterToSettle(panel, false, 3_000);
    await linkedin.waitForTimeout(750);

    const phase3 = await auditVisibleCardsForPhrase(linkedin, 'Mandarin');
    test
      .info()
      .annotations.push({ type: 'phase3', description: JSON.stringify(phase3) });
    expect(
      phase3.leakedIds,
      `Visible cards still containing "Mandarin": ${phase3.leakedIds.join(', ')}`,
    ).toHaveLength(0);
    // The Lead filter must still also hold.
    const phase3Lead = await auditVisibleCardsForPhrase(linkedin, 'Lead');
    expect(
      phase3Lead.leakedIds,
      `After adding Mandarin, visible cards still contain "Lead": ${phase3Lead.leakedIds.join(', ')}`,
    ).toHaveLength(0);

    // Final state probe — useful when debugging from the trace.
    const finalState = await readPanelState(panel);
    test
      .info()
      .annotations.push({ type: 'final-state', description: JSON.stringify(finalState) });
    expect(finalState?.filterPhrases.sort()).toEqual(['Lead', 'Mandarin']);
  });
});
