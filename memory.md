# Memory — Sieve

Lessons learned during the build. Most recent on top. Per project CLAUDE.md: any
finding worth saving the next session a re-derivation goes here.

---

## 2026-06-12 (later) · Feedback round 2: the Carousell numeric bug was a hardcoded field name, not parsing; grid fixtures assert `.ctile` not `.sliver`; "page detected" sentinel is data-role="page-detected"

The real reason "Price > 4000" never worked on Carousell: panel.ts bound
the numeric editor to a field literally named `comp` (rolecast prototype)
with a 0–300 "$k" slider — the comma-parse fix (below) was necessary but
could never be sufficient. No hint can fix a filter the panel never
renders. Generalized: `numericFieldOf(schema)` = first number-kind field;
free number input. `detectPriceField()` (discover.ts) synthesizes a local
`price` field from the consistently currency-formatted innermost element
(coverage ≥ max(2, half the items) + first-match verification), so numeric
filtering works with NO LLM key; it also repairs LLM schemas that lack a
number field. Currency marker REQUIRED — bare numbers ("3 days ago",
"12 likes") must never become a price.

Spec gotchas worth not re-deriving: grid-classified pages render the
`.ctile` placeholder, lists render `.sliver`, carousels `.sliver-v` — a
grid fixture asserting `.sliver` fails with verdicts working perfectly
(debugged exactly this on tests/4.16). And since the Collapse|Hide toggle
is gone (bugs.md #3), the "panel knows a schema exists" wait is
`[data-role="page-detected"]` on the status line (ext-env + 4 specs).

Suggestions (bugs.md #1 round 2): ranking is top-recurring-first within a
[15%, 90%] doc-frequency band; unigrams beat bigrams on ties and absorb
overlapping bigrams ("Apple" suppresses "Apple Watch" — the broader filter
already covers it; "mac mini" still surfaces because "mac" is under the
4-char unigram floor). LLM curation path sends ONLY these candidate tokens
(PRIVACY.md updated accordingly) and falls back to the local list on any
error — tested with an unreachable baseUrl.

Brand state (settled 2026-06-12): product name = **Negative Filter**;
"sieve" is only the repo + zip artifact name (out/sieve-<v>.zip, pinned
by the 6.5 spec). Visual identity = funnel-rows mark (3 narrowing list
rows: white / soft-white / amber) on an emerald tonal gradient
(#34d399→#059669), Material-style; wordmark "Negative" white + "Filter"
emerald, Roboto. Source of truth: scripts/icons.mjs (extension icons) +
scripts/store-tiles.mjs (promo tiles); hero recomposed on the emerald
gradient. Concept exploration lives in out/store-assets/logo-concepts/.
Still open: PRIVACY.md's H1 says "Sieve" (user's own edit) — must match
the listing name before store submission. Panel UI accent is still blue
(--accent in panel.css); switching it to emerald was offered, not
confirmed.

## 2026-06-12 · User bug batch (bugs.md): YouTube 0-items = non-unique itemSetSelector + first-match scoping; 429 backoff over-escalated on concurrent failures

Live probe on youtube.com/watch (bugs.md #6): 20 `yt-lockup-view-model`
related videos, 16 matching the filter, but the panel said "list · 0
items". buildLocalSchema's selectors were fine (doc-wide itemSelector → 20,
all inside the detected `div#contents`), but the generated itemSetSelector
matched FOUR elements and the real container wasn't first —
findItems' `querySelector` first-match scoping rooted at an empty
lookalike. Fix: `findItems(schema, doc, knownItemSet?)` — mount() passes
the detected container explicitly; otherwise `bestRoot()` picks the
set-selector candidate containing the most item matches. Spec
tests/2.10-finditems-root.spec.ts.

Also from the LinkedIn re-verify (page-1: 24 unique requests, 20×200 +
4×429, hidden=3 — viewport-first working): the trailing in-flight 429s
each escalated the shared cooldown (4s→8s→16s→32s), stalling page-2's
scan ~30s. Concurrent failures from one burst now escalate ONCE (only a
429 arriving AFTER the previous cooldown expired bumps `consecutive`).

bugs.md batch status: #2 comma-separated numbers + #4 whitespace-squashed
phrase matching fixed (engine worker, 7 new spec cases); #3/#5/F1/F2 in
flight (panel worker); #6 fixed as above; #1/#7/F3/F4 pending.

---

## 2026-06-11 · Pagination "Hidden (0)" root cause #2: remount churn tripped the jobs-guest rate limit

Five live probes nailed the rest of the user's pagination report. Facts:
v2 "Page 2" REPLACES the whole LazyColumn container (not just a wrapper),
churns the URL through ~4 states in ~2s (re-encoded keywords → +start=25 →
+currentJobId), and the SPA relay correctly re-detected on each. After the
churn the content state was PERFECT (filters carried, 25 fresh items, v2
stub) and card-text filters applied instantly. But ground truth via direct
fetch showed **9/10 jobs-guest description fetches failing** — each of the
4 remounts created a fresh DeepTextScanner (cache died with ctx, per the
2026-06-06 note) and re-fetched all 25 descriptions; ~100 requests in
seconds tripped LinkedIn's limiter; failures are silent by design (miss,
never false-hide), so description-dependent phrases like "mandarin" simply
stopped matching → chip present, items detected, Hidden (0).

Fixes: (1) deep-text cache is now MODULE-level, shared across scanner
instances/remounts (`DeepTextScannerOpts.cache` injectable for tests;
failures still uncached so they retry); (2) handleSpaUrlChange debounces
1200ms trailing (the churn's events arrive >400ms apart — 400ms didn't
collapse them); (3) maybeScanDescriptions schedules a single 12s re-scan
pass when items still lack text (scan() skips cached/in-flight, so it only
touches failures).
Probe caveat for future sessions: after a probe burst the limiter stays
hot for a while — a "0 hidden on page 2" result right after heavy probing
is ambiguous; check fetch success-rate, not hidden-count.

Probe 6 (network histogram) then quantified the limiter: ~20 jobs-guest
requests per window (page-1 scan: 20×200 + 5×429; page-2 burst: 48×429,
zero 200s). One page's scan EATS the whole budget, so page-2 description
filters could never match right after paging regardless of dedupe. The
durable fix wires the Slice-5 ideas into DeepTextScanner itself:
`fetchDetailResult` surfaces 429 distinctly; a shared cross-instance
cooldown backs off exponentially (4s→60s) and re-queues the URL (attempts
capped at 4); `scan()` orders new work viewport-first so whatever budget
exists is spent on the cards the user is actually looking at; the
in-flight set is shared across instances like the cache. Net behavior on
page 2 under a hot limiter: visible cards' descriptions arrive first as
the cooldown drains, matches collapse progressively instead of never.

---

## 2026-06-11 · LazyColumn pagination invisible to the watcher — childList-without-subtree was the 4.10-header gap, now closed

User screenshot: chip "mandarin" present, 25 items detected, HIDDEN (0)
after paging on /jobs/search-results/. Root cause is the gap 4.10's header
predicted: pagination REPLACES a nested wrapper inside the LazyColumn —
same URL (no SPA relay fires), same itemSet element (no re-detect), and
the new cards are children of the swapped wrapper, NOT of the itemSet, so
a childList-only MutationWatcher never saw them. ctx.items stayed the
disconnected page-1 set (textContent still reads on detached nodes, so the
engine kept "working" on ghosts).

Fix: (1) watcher observes `{childList, subtree}` and, for added nodes that
don't match itemSelector themselves, scans `node.querySelectorAll(
itemSelector)` — renderer-owned nodes excluded at both levels; (2)
content's onItemsAdded prunes disconnected items and dedupes via a Set
(re-parented wrappers can re-deliver known cards; unwrap() re-delivers the
item it just unwrapped). Fixture linkedin-paginated-lazycolumn.html + e2e
tests/4.13 (host alias `linkedin.test` makes the v2 stub engage for real).
Subtree observation is safe loop-wise because the watcher only reacts to
childList and skips renderer nodes — attribute writes (detached mode)
never fire it.

---

## 2026-06-11 · Tag-only itemSelector + MutationWatcher = infinite wrap loop (wedged GitHub's main thread)

Follow-on from the detection-precision fix: with `div.list > div` as the
itemSelector, the renderer's own `.filt` wrapper (a direct-child div)
MATCHES the selector. MutationWatcher's "wrappers self-skip via
matches(itemSelector)" assumption only holds for classed selectors. The
loop: wrap inserts wrapper → watcher ingests wrapper as a new item →
engine filters it (it contains the card's text) → renderer wraps the
wrapper → repeat forever; the page's main thread wedges (live GitHub
smoke hit a 150s watchdog at the phrase step, 1-in-3 runs). Fix:
`isRendererNode()` check (`.filt/.sliver/.sliver-v/.ctile/.rehide/
.nf-check-mark`) before matchesItem in mutations.ts. Regression:
tests/4.12-watcher-wrapper-loop.spec.ts (asserts zero ingestions after
wrap, zero nested wrappers, AND that a genuinely-late card still flows).

---

## 2026-06-11 · localizeItemSet "pick whichever matches more" was a trap; findItems now roots at the itemSet

GitHub search live probe explained the 212-item over-detection: the modal
child of the detected list container was a classless `<div>`, so
`leafSelector` degraded to bare `div`, and the picker preferred it over
the container-scoped selector because document-wide `div` "matches more".
Backwards: matching more with a generic leaf means matching the page.
Scoped now wins whenever it covers the modal group; the bare leaf only
rescues a scoping path that LOSES cards (hashed/ambiguous container).
Belt-and-braces: `findItems` roots its querySelectorAll at the itemSet
container when it resolves — also protects against over-generic
LLM-returned selectors. After both: GitHub = 10 items, all real result
cards. Probing tip: GitHub's CSP blocks `addScriptTag`; pass
`bypassCSP: true` to the Playwright context for testbed injection.

---

## 2026-06-11 · 4.10 GREEN ON LIVE LINKEDIN — the SPA gap was the last blocker; fixed via SW tabs.onUpdated relay

The 2026-06-06 "open audit" became load-bearing: LinkedIn's search submit
is a true SPA navigation now (no full reload), so the isolated-world
history patch never fired, the content script kept evaluating the OLD
page's disconnected elements (engine reported itemsFiltered > 0 with zero
renderer output in the live DOM — 4.10's failure mode B). Fix with no new
permissions: `chrome.tabs.onUpdated` fires with `changeInfo.url` on
page-realm pushState; sw.ts relays it as a new `spaNavigated` message;
content's handler (`handleSpaUrlChange`, extracted from the old watcher)
does an idempotent-per-URL stub-first force re-detect with filter
carryover. Unlike `rediscover`, `spaNavigated` must NOT bypassStub.
`tests/4.11-spa-relay.spec.ts` covers it synthetically (page.evaluate
pushState runs in the MAIN world — exactly a real SPA router; fails
without the relay). 4.10 then passed against live LinkedIn in 17.9s:
Lead filter on /collections/recommended → SPA search "Tech Lead" →
filter persists + applies on the v2 LazyColumn → Mandarin deep-text.
Also: 4.10's RECOMMENDED_URL must not pin a currentJobId — ids go stale
within days and LinkedIn answers with an HTTP error
(ERR_HTTP_RESPONSE_CODE_FAILURE), which looks like an auth failure but
isn't. The bare /jobs/collections/recommended/ URL self-heals.

---

## 2026-06-11 · Nested itemSelector matches blank the page — findItems now keeps innermost matches only

Even after the table-detached fix, live HN still rendered only the slivers.
Root cause one level up: HN's whole page is nested tables, and the local
schema's generic row selector matched `<tr>`s at EVERY level — including
the outer layout row that contains the entire story list. That ancestor's
textContent aggregates every story, so any phrase match "filtered" it, and
collapsing it blanked the page. `findItems()` now prunes any match that
contains another match (`el.querySelector(itemSelector) !== null` → it's a
container, not an item). Verified live: HN renders the full list with
in-place "Hidden — AI" bars (95 items, 9 hidden); GitHub search works in
wrap mode (its React doesn't revert wrappers). old.reddit.com headless is
bot-walled ("blocked by network security") — don't use it as a smoke
target. Known cosmetic gap on HN: a hidden story's subtext row (separate
`<tr>`) stays visible; fixing it needs a multi-row item concept.

---

## 2026-06-11 · Live HN smoke caught two renderer bugs: div-wrap inside <tbody> collapses the whole table; HIDDEN labels degrade to nf-N ids

First live test on news.ycombinator.com (extension loaded, enable clicked,
"AI" phrase): engine + detection worked (98 items, 10 filtered) but the
PAGE rendered only the slivers — every passing story row vanished.

1. **Wrapping a `<tr>` in `<div class="filt">` is invalid table structure.**
   The browser's table layout breaks and the rest of the rows stop
   rendering. The wrap-revert auto-fallback can't catch it: the wrapper
   stays connected, the layout just dies. Fix: `apply()` checks the first
   item's tag against TABLE_PART_TAGS (TR/TD/TH/TBODY/THEAD/TFOOT) and
   force-switches to detached mode before any wrapping. Table rows get
   their own detached CSS arm: cells `display:none` (NOT visibility —
   hidden cells still occupy their full height) and the `::before` reason
   renders as `display: table-cell` (an absolutely-positioned bar
   contributes no height to a row). No re-hide pseudo-bar on restored rows
   — a block `::before` on a `<tr>` gets wrapped into an anonymous first
   cell and shifts every real cell over by one column; the panel HIDDEN
   list covers re-hide there. Fixture table-list.html + tests/6.8.

2. **`readLabel` returned undefined for local/stub schemas (empty
   `fields`)** so the panel HIDDEN list showed synthetic ids (nf-1, nf-4…).
   Now falls back to the item's whitespace-normalized textContent capped
   at 64 chars.

Also noted on HN, not yet addressed: stories are tr-triplets (title row +
subtext row + spacer) and detect() groups all `<tr>`s, so hiding a story
row leaves its subtext row visible. Cosmetic; a multi-row item concept
would be needed to fix properly.

---

## 2026-06-11 · Panel redesign gotchas: occluded-tab CSS transitions freeze mid-blend; `<details>` hides spec targets

Two findings from the side-panel visual overhaul:

1. **CSS `transition` on colors renders frozen mid-blend in occluded tabs.**
   When the panel page is backgrounded (Playwright tab not front, or a
   side-panel re-render racing a theme change), in-flight color transitions
   stop compositing and screenshots/users catch buttons stuck between the
   from/to colors. Fix was to drop transitions on color properties in
   panel.css. If hover polish is ever re-added, scope it to
   `@media (prefers-reduced-motion: no-preference)` and non-color properties.

2. **Moving a section into a collapsed `<details>` breaks specs that click
   its controls.** Children of a closed `<details>` exist in the DOM (so
   `waitForSelector` resolves if the target is the `<details>` itself) but
   aren't interactable. The LLM-settings disclosure keeps
   `data-role="llm-settings"` on the always-visible `<details>` element and
   specs (3.4, 4.7, 6.4) click the `summary` first. Any future section that
   moves behind a disclosure needs the same treatment. Open/closed state is
   preserved across `render()` re-paints by reading the live element before
   `replaceChildren`.

Also: the spend meter is now gated on a saved API key — specs that assert
meter copy must seed `nf:llm-settings` first (4.7 does).

---

## 2026-06-10 · Renderer "detached" mode + auto-fallback fixes the React wrap-revert (closes the 4.10 P0)

The v2 LazyColumn revert (entry below, was UNFIXED) is fixed by a second
rendering strategy in `renderer.ts` that **never reparents and never inserts
nodes into the React-managed parent**:

  - **Detached mode**: a filtered item gets `nf-filt-item` +
    `data-nf-reason` + `data-nf-id` on the item itself. Injected CSS
    collapses it to a 28px bar (`height/overflow !important`, direct
    children `visibility:hidden`) and renders the reason via
    `::before { content: attr(data-nf-reason) }`. Restored state =
    `nf-restored` class; the re-hide affordance is an in-flow `::before`
    bar at the top of the card. Class/attr mutations on a React-owned node
    survive reconciliation of that node's children; when React re-renders
    the element's own props, the self-heal observer re-applies.
  - **Clicks** are a document-level capture listener (no per-item
    listeners to lose). Collapsed item → restore (event swallowed so the
    role=button card doesn't navigate). Restored item → re-hide only when
    the click lands ON the item element itself within the top 40px (the
    bar zone) — descendants (the card's own links) pass through.
  - **Self-heal**: one MutationObserver per renderer on the itemSet
    subtree (childList + attributeFilter class/data-nf-*), microtask-
    debounced. Detached: re-applies only when expected state diverges
    (idempotent → no fight loop). Wrap mode: detects "tracked wrapper
    disconnected while its item is connected" → **permanently** switches
    the instance to detached, unwinds connected wrappers (preserving
    restored flags), re-applies lastVerdicts. Same check runs at the top
    of `apply()` — this auto-fallback protects unknown React sites, no
    stub needed.
  - **Mode selection**: `Schema.renderMode?: 'wrap' | 'detached'`
    (default 'wrap' — all prior behavior incl. the 1.4 byte-identical
    contract unchanged). `LINKEDIN_JOBS_NEW_STUB` sets `'detached'`.
  - `summaries()` / panel contract identical in both modes; `setRestored`
    routes by mode; `mode-hide` has a detached rule
    (`.mode-hide .nf-filt-item:not(.nf-restored) { display:none }`).
  - **Renderer.disconnect()** added and called in `content/index.ts
    mount()` teardown — without it, a replaced renderer's heal observer
    keeps re-collapsing items the new renderer no longer filters (the
    same-fingerprint SPA remount reuses the same item elements).

Verified by `tests/6.7-detached-renderer.spec.ts` against the new hostile
fixture `fixtures/react-revert.html` (an inline "reconciler" that removes
unknown children, rescues reparented cards, and resets classNames on a
timer + on demand via `window.__reactRender(i)`). 4.10's phase-2 DOM
assertion now accepts either `.filt` or `.nf-filt-item`; the engine-side
assertions are unchanged, and it still needs a live run under
`NF_LINKEDIN_USER_DATA` to confirm against real LinkedIn (inline
virtualization sizing on LazyColumn rows is the main residual risk —
the collapse CSS uses !important, which beats non-important inline
styles, but a row React re-renders with important inline height would
need the heal path to win on cadence).

---

## 2026-06-06 · Two SPA bugs surfaced together: stub-bypass on URL change + suggestPhrases dropped baseUrl

User on LinkedIn `/jobs/search-results/?…&keywords=…` reported that the
extension "stops working on new search" and that "Suggest phrases" failed
with `Failed to fetch`. Two independent bugs:

1. **SPA URL change bypassed the stub.** `installSpaNavigationWatcher` in
   `content/index.ts` calls `tryDiscover({ force: true })` on every
   pushState/replaceState. The old `attemptDiscover` interpreted `force:true`
   as "skip the stub" (intent was: panel "Re-discover with hint" should
   engage the LLM). Result: each new LinkedIn search routed to LLM
   `discover()` → "Failed to fetch" → `buildLocalSchema()` fallback, which
   is unreliable on the virtualized LazyColumn. **Fix:** bypass the stub
   only when `opts.hint` is supplied — that's the only path that genuinely
   wants the LLM. Forced re-detect from SPA route change still tries the
   stub first.

2. **`suggestPhrases` ignored `LlmSettings.baseUrl`.** `SuggestPhrasesOpts`
   had no `baseUrl` field, so a user with provider=openai +
   baseUrl=`https://openrouter.ai/api` had their Suggest button hit
   `api.openai.com` (the OpenAI default). The user almost certainly hasn't
   granted host permission for `api.openai.com/*`, so the fetch fails with
   "Failed to fetch". Symmetry bug — `discoverSchema` already plumbed
   baseUrl through. **Fix:** add `baseUrl?: string` to `SuggestPhrasesOpts`,
   forward in `suggestPhrases`, pass from `panel.handleSuggest`.

**Adjacent UX cleanup:** `handleSaveLlmSettings` ignored the return value of
`chrome.permissions.request` — a declined prompt silently failed and
surfaced later as "Failed to fetch" on the next call. Now it stores a clear
discoverError describing the denied origin. Also `handleSuggest` does a
pre-check via `chrome.permissions.contains` and falls back to decorating
"Failed to fetch" with the missing match pattern.

**Follow-on bug surfaced by the stub-bypass fix:** even once SPA navigation
correctly re-mounted the stub, the user's typed-but-unsaved phrases were
lost on each new search because `mount()` reset `ctx.filters = []` and
`ctx.mode = 'collapse'` on every call. Fix: when re-mounting under the same
fingerprint, carry over `filters` + `mode` from the previous ctx, kick off
`maybeScanDescriptions` (deep-text cache was cleared with the old ctx, so
LinkedIn body-text matches need to refetch), and SKIP `hydrateSavedFilters`
— the carried set is the live session state, not the stale saved snapshot.
A fingerprint change still resets, because filters tagged for one layout
don't sensibly apply to another.

**Deeper bug behind both of the above:** `installSpaNavigationWatcher`
monkey-patches `history.pushState` / `replaceState` and listens for
`popstate`. In an MV3 isolated content-script world the monkey-patch
**doesn't cross realms** — the page-realm `history.pushState` stays the
native function (verified empirically: `history.pushState.toString().length
=== 38` from page-evaluate after the content-script patched it). So on real
SPAs (LinkedIn included) the watcher silently never fires; the stub re-mount
fix above is reachable only via the panel's "Re-discover" button or via
genuinely-full reloads. The real production trigger for "filters disappear
on new LinkedIn search" is the full reload that LinkedIn's search submit
performs: content script re-injects with empty `ctx.filters` (no saved set
to hydrate), `chrome.tabs.onUpdated` fires `panel.refresh()`, which then
clobbers `state.phrases` with content's empty list — both chip and
filtering vanish.

**Fix:** `panel.refresh()` snapshots `prevPhrases` / `prevNumeric` /
`prevOrigin` before re-reading content. If the active tab is still the same
origin and content reports empty filters but the panel had typed phrases,
preserve the snapshot AND re-`pushFilters()` so content re-applies them.
Regression covered by `tests/4.9-spa-navigation.spec.ts`. Also updated
`tests/4.5-saved-filters.spec.ts` — its old "Clear Saved + reload = 0
slivers" assertion was conflating two lifecycles; the new contract is
"Clear Saved purges storage only; chips removed by × click."

**Open audit:** if a future need arises to actually intercept page-realm
pushState, either inject a `world: 'MAIN'` companion script or use
the Chromium `Navigation` API. Don't trust the current `installSpaNavigationWatcher`
to fire on real SPAs.

---

## 2026-06-06 · LIVE LinkedIn test (4.10) — renderer's DOM wrap is reverted by React on the v2 LazyColumn layout (FIXED 2026-06-10 — see top entry: detached mode + auto-fallback)

Hit the actual site via `tests/4.10-linkedin-recommended-scenario.spec.ts`
with a manually-bootstrapped Chrome profile. The 7-step user scenario
**reproduces in production** in a specific way the synthetic fixture didn't
expose, and revealed a third bug beyond the two we already fixed.

**Observation pipeline.** On `/jobs/collections/recommended/...` LinkedIn
served the v1 (legacy `<ul>/<li class="scaffold-layout__list-item">`)
layout — `LINKEDIN_JOBS_STUB` (`site:linkedin:jobs:v1`) mounted, "Lead"
filter hid 7/24 cards (real `.filt` wrappers in the DOM). Then we navigate
to `/jobs/search-results/?keywords=Tech%20Lead` — same origin, same tab.
LinkedIn serves the v2 (LazyColumn, `[componentkey="SearchResultsMainContent"]`)
layout instead. Panel-side preservation re-pushed the filter; content
mounted the v2 stub; engine reported `itemsFiltered: 15` (later 18 on a
different run) — i.e. the engine's view is correct. **But the DOM has zero
`.filt` and zero `.sliver` nodes.** Cards visibly unhidden, user sees the
exact "filters don't apply on new search" symptom.

**Root cause hypothesis.** `Renderer.wrap()` (extension/content/renderer.ts:359)
does `item.replaceWith(wrapper); wrapper.appendChild(item)`. On v1 LinkedIn
the `<li>` parent is server-rendered and React doesn't re-render the row,
so the wrap sticks. On v2 the LazyColumn is a virtualized React component;
the next render cycle compares the actual DOM to React's vDOM, sees our
unexpected `<div class="filt">` interloper, and reverts the row to its
expected shape — silently ripping out our wrappers. The `wrapperByItem`
WeakMap still believes they exist (so Spike B's `handleRecycledItem` can't
self-heal — it only triggers on data-id divergence on a node it can find).

**What to try when picking this up.**
  1. Drop DOM mutation entirely on `layout: 'list'` items: instead of
     wrapping, add a class to the item itself (`item.classList.add('nf-filt')`)
     and inject the sliver as a sibling via the parent. CSS rule on the
     class hides the item, sibling renders the sliver. No wrapper, no
     React conflict. Risk: parent might also be React-managed and
     strip the sibling, but the item itself is the React-owned node so
     adding a className survives React's reconciliation of own children.
  2. Alternatively, observe wrapperByItem entries with a MutationObserver
     on each wrapper's intended parent — re-wrap immediately if React
     removes our node. Heavier; turns the renderer into a fight against
     React.
  3. As a discovery, snapshot what `[role="button"][componentkey^="job-card-component-ref-"]`'s
     direct parent looks like at the moment of wrap() — that's the React
     fiber owning the row.

**Test surface.** `tests/4.10-linkedin-recommended-scenario.spec.ts` runs
against the real site behind `NF_LINKEDIN_USER_DATA`. It's headed (LinkedIn
fingerprints headless), skips cleanly without the env var, and its phase-2
failure message disambiguates the three failure modes (engine-side filter
loss, mutation-watcher gap, vs renderer-wrap-reverted). It's currently RED
on real LinkedIn until (1)/(2) above lands. Don't delete or mute it —
treat it as the regression gate.

**Future audit:** any other LLM call site? Currently `discoverSchema` (SW)
and `suggestPhrases` (panel) are the only outbound LLM endpoints. If
Slice 5/6 add another (e.g., taught-example refinement), it must plumb
baseUrl through the same way.

---

## 2026-06-05 · LinkedIn `/jobs/search-results/` redeployed to a new LazyColumn — stub + itemDetailUrl needed a second site rule

User reported filters "not loading" on
`linkedin.com/jobs/search-results/?currentJobId=…&keywords=mandarin&…`. Live
DOM probe (MCP Playwright on the logged-in page) found that LinkedIn ships
**two parallel layouts** for jobs lists right now:

  - **`/jobs/search/?...`** still uses the old `<ul><li class="scaffold-layout__list-item">` structure
    with `data-occludable-job-id` on every card (25/25). Our existing
    `LINKEDIN_JOBS_STUB` keeps working there.
  - **`/jobs/search-results/?currentJobId=…`** is a NEW virtualized
    LazyColumn: container is `[componentkey="SearchResultsMainContent"]`
    (`data-testid="lazy-column"`, `data-component-type="LazyColumn"`); each
    card is a `<div role="button" componentkey="job-card-component-ref-<jobId>">`.
    The job id lives **only** in the `componentkey` attribute — no
    `data-occludable-job-id`, no `data-job-id`, and `a[href*="/jobs/view/"]`
    only appears on the currently-focused card (1/25). Visible card text
    holds title/company/location only (no description), so the keyword
    "mandarin" matches zero cards by card text — the deep-text fetch is
    load-bearing.
  - Bonus gotcha: `[componentkey^="job-card-component-ref-"]` returns **2×**
    the card count because each job has BOTH an outer `<div role="button">`
    and an inner content `<div>` carrying the SAME componentkey. The
    `[role="button"]` qualifier dedups to 25.

**Fix:**
  1. `schema-stub.ts` adds `LINKEDIN_JOBS_NEW_STUB`
     (`fingerprint: 'site:linkedin:jobs:v2'`,
     `itemSetSelector: '[componentkey="SearchResultsMainContent"]'`,
     `itemSelector: '[componentkey="SearchResultsMainContent"] [role="button"][componentkey^="job-card-component-ref-"]'`).
     Registered BEFORE the v1 stub in `ALL_STUBS` — new layout wins when
     both are matchable mid-SPA-transition; v1 is still the fallback for
     `/jobs/search/`.
  2. `deep-text.ts` `itemDetailUrl` prepends a componentkey path:
     parse `^job-card-component-ref-(\d+)$` off the matched element (or its
     self-or-descendant carrying that attribute). Existing
     `data-occludable-job-id` / `data-job-id` / `/jobs/view/` paths stay as
     fallbacks so neither layout regresses.

Verified end-to-end on the live page (logged-in, viewport 1440×900):
itemSet found, 25 items, 5/5 detail fetches OK (status 200, 50–66 kB each),
3/5 first-batch descriptions contain "mandarin" — those cards will hide once
the scanner delivers the text (DeepTextScanner debounces a recompute at 150
ms). 0 cards match "mandarin" on the card text alone, which is exactly why
the user's pre-fix filter hid nothing.

**Operational note:** after the rebuild the user must reload the unpacked
extension AND reload the tab AND re-toggle enable (per the earlier
`MutationWatcher`/registerContentScripts gotcha). On `/jobs/search-results/`
without `currentJobId`, LinkedIn auto-adds it and renders the dual-pane
layout — both stubs match on subsequent navigations, so the cursor doesn't
need to manually choose the URL.

## 2026-06-04 · "No list detected" on real SPA sites — detect.ts ignored volatile classes

User reported the extension detects no list on linkedin.com/jobs (panel:
"No list detected", spend 0 → LLM never reached, so it fails *before*
discovery in the local `detect()` heuristic).

**Root cause:** `detect.ts`'s `signatureOf()` grouped sibling elements by
their **full** class list. Real cards carry per-item / per-deploy class
tokens (CSS-in-JS hashes `css-1abc23`, CSS-module `Card__a8K2`,
styled-jsx, Ember view ids). Each structurally-identical card therefore
got a *different* signature → fragmented into singleton groups → no group
≥ MIN_GROUP_SIZE → `detect()` returns null (or a stable-classed nav bar
out-scores the real list). Reproduced on the project's OWN
`rolecast-v3-utility-noise.html` fixture: old `detect()` returned **null**.
Ironically `fingerprint.ts`'s `nodeShape()` already stripped these and its
comment claimed it "mirrors detect.ts's signatureOf" — but detect never
did the stripping.

**Fix:** new shared module `extension/content/stable-classes.ts`
(`isVolatileClass` / `stableClasses` / `stableShape`). Both `detect.ts`
(`signatureOf`, `leafSelector`) and `fingerprint.ts` (`nodeShape`) now
source the strip from it, so the two modules can never drift again. Added
a **tag-only fallback** (`evaluateParentByTag`) in detect's
`evaluateParent` that only fires when stable-class grouping yields no
qualifying group — rescues lists whose per-item noise escapes the
patterns, with zero effect on clean pages (no regression). Verified all 5
detect cases (rolecast/carousel/grid/utility-noise/linkedin) + generalize
+ fingerprint by running the real bundled `dist/testbed/runtime.js` under
jsdom. Bonus: utility-noise now fingerprint-aliases rolecast (the 6.2
goal), so it won't trigger a wasted LLM call.

## 2026-06-04 (later 7) · "Whole thing broken" — one early LLM error aborted the entire discovery retry loop

Console (Claude in Chrome): `discover failed: SchemaParseError:
detailFieldSelectors must be string→string`. Chain: at t=0 the SPA list
isn't hydrated, so the site stub doesn't match yet → falls through to the
LLM → deepseek returns a schema with detailFieldSelectors in the wrong shape
→ parser THREW → tryDiscover's loop catch did `emitDiscoverError; return`,
which ABORTED the whole retry. So once the cards finally mounted, the stub
was never re-checked → nothing mounted → BOTH title and body filters dead.

Fixes:
  1. `tryDiscover` loop: a per-attempt error no longer returns/aborts —
     record it and keep retrying (stub/local succeeds once cards hydrate).
     The mutation-watcher's `attempt()` catch likewise keeps watching instead
     of tearing down; the 60s give-up surfaces a final error only if nothing
     ever works.
  2. llm.ts schema parser: malformed `detailLinkSelector` /
     `detailFieldSelectors` are now DROPPED, not thrown — they're optional
     deep-page niceties and must not sink an otherwise-valid schema. (No test
     asserted the throw.)
Verified live on /jobs/search AND the /jobs/collections/recommended page the
user sent: stub matches (24-25 `li.scaffold-layout__list-item`), id coverage
24/24, deep fetch OK, mandarin found. NOTE: occluded cards have little visible
text, so even TITLE matches on off-screen cards rely on the fetched
description (which contains the title) — another reason deep-text matters.

## 2026-06-04 (later 6) · In-body filter hid nothing — itemDetailUrl read the rendered link, which virtualization strips

After the stub landed (detection → 27 items), the "Mandarin" description
filter still hid 0. Live debug: `itemDetailUrl` looked for
`a[href*="/jobs/view/"]` inside each card, but LinkedIn VIRTUALIZES the list
— only ~7 of 25 cards (the on-screen ones) render that anchor. So 18/25 cards
yielded no URL → no description fetched → never matched. fetchDetailText
swallows errors → silent.

Fix: read the job id from `data-occludable-job-id` (present on ALL 25 cards,
occluded or not; `data-job-id` only on rendered ones), self-or-descendant
only (never an ancestor — would share one id across siblings), with the
`/jobs/view/` link + generic anchor as fallbacks. Verified live: id coverage
25/25, 15/15 fetches OK, and it caught a Mandarin job whose CARD TITLE WAS
EMPTY (an occluded placeholder the old code couldn't reach). Test 2.9 now
asserts the occluded-card (data-attr only) path.

Still unverified end-to-end inside the extension: the fetch runs in the
content script's ISOLATED world. Main-world fetch to the guest endpoint works
(so the page CSP allows same-origin connect), so isolated-world should too —
but if the user reports it still hides nothing after reload, move the fetch
into the SW (not subject to page CSP; host_permissions bypass CORS) via a
content→SW round-trip, mirroring deep-runner's pattern.

## 2026-06-04 (later 5) · Heuristic detection is fragile on LinkedIn's live virtualized list → added a site stub

After the deep-text build the user saw "no filter shows up". Live debug
(Claude in Chrome) on a results page with a job selected: the content script
WAS injected (SW round-trip logged, no errors), but detect() picked a dense
`DIV` cluster of 8 (score 304) over the 25-card job list. Two live-only
effects the synthetic fixtures didn't capture:
  1. **Virtualization** — off-screen cards are near-empty placeholders, so
     the 25-card list's mean descendant count was only ~13 → low score.
  2. **Partial state class** — 18 of 25 cards carry an extra
     `jobs-search-results__job-card-search--generic-occludable-area` class,
     7 don't, so stable-class grouping splits them 18/7 (largest group 18,
     not 25). The hash-strip can't catch it (it's a real BEM-ish class).
Net: the structural heuristic is inherently unreliable on LinkedIn.

**Fix: deterministic site stub** (schema-stub.ts `LINKEDIN_JOBS_STUB`,
gated by hostname incl. 'linkedin.'): `itemSetSelector:
'ul:has(> li.scaffold-layout__list-item)'`, `itemSelector:
'li.scaffold-layout__list-item'` (the one class on every card regardless of
occlusion/promotion), empty fields. `pickStubSchema` now host-gates entries
and try/catches the selector (`:has()` is Chrome 120+, our target; jsdom's
nwsapi also supports it). `attemptDiscover` checks the stub FIRST on every
SPA-retry attempt (not just at init) so it catches LinkedIn's late hydration.
Verified live: `ul:has(...)`→1, `li.scaffold-layout__list-item`→25; jsdom:
stub returns site:linkedin:jobs:v1, findItems matches all cards incl. the
fragmented one. Heuristic + local-schema remain the fallback for other sites.

Gotcha for next time: reloading an unpacked extension at chrome://extensions
can drop dynamically-registered content scripts and panel↔SW state; user must
reload the page (and sometimes re-toggle enable) after an extension reload.

## 2026-06-04 (later 4) · In-body (description) keyword filtering — fetch + fold, no hidden tabs

User: keyword "mandarin" didn't hide a job whose DESCRIPTION mentions it.
Confirmed via Claude in Chrome: the term is only in the job description, NOT
in the list card (cards carry title/company/location only). The scaffolded
Slice-5 "Deep scan" (hidden tabs) was NEVER wired into the running extension
(`runOne` only referenced in tests; index.ts imports none of it).

**Chosen approach (user picked auto-fetch):** same-origin fetch of LinkedIn's
SERVER-RENDERED guest endpoint `jobs-guest/jobs/api/jobPosting/<id>`, strip
tags, match the whole response text. New `extension/content/deep-text.ts`:
`itemDetailUrl` (LinkedIn /jobs/view/<id> → guest URL; generic anchor
fallback), `stripHtml`, `fetchDetailText` (credentials:'include', null on
non-2xx), and `DeepTextScanner` (worker pool, concurrency 3, 250ms spacing,
URL-keyed cache, dedups in-flight, re-delivers cache hits to onText).
Engine: `evaluate(schema, items, filters, detailText?)` + `readField` folds
`detailText.get(item)` into ALL_TEXT_FIELD. index.ts: ctx gains
`detailText`/`scanner`; `maybeScanDescriptions` runs only when a phrase
filter is active; scanner.onText updates detailText + debounced recompute
(150ms) so cards hide as descriptions arrive. No SW change; same-origin so
the existing linkedin host permission covers the fetch.

**Why whole-response match (not a description selector):** the guest HTML
structure is inconsistent (sometimes login-wall chrome, DOMParser flaky,
rate-limits on bursts). Matching stripped full text degrades gracefully — a
walled/empty response just lacks the keyword (a miss), never a false hide.
Verified live: scanning 12 cards, "mandarin" hid 2 by description (0 by card
text). Verified the engine fold / scanner / stripHtml / URL mapping via jsdom
on the real bundle. Tests: 2.9-deep-text.spec. Reliability caveat: a few jobs
may not resolve (rate-limit/wall) → fall through to card-level for those.

## 2026-06-04 (later 3) · "Detected: list · 1 item" on live LinkedIn — SOLVED via live DOM inspection (Claude in Chrome)

Connected Claude in Chrome and inspected the real linkedin.com/jobs/search
DOM. Three compounding bugs in detect(), all now fixed and verified live
(detect picks the 25-card `ul`; selector matches all 25; keyword filter
hides correctly — Director→7, Engineer→2, Hong Kong→20):

1. **Scoring favored giant wrappers.** `score = groupSize × meanDescendants`
   let a cluster of 5 enormous top-level `<div>`s (application-outlet)
   out-score the 25-card list. Added `DESCENDANT_CAP = 40` in detect.ts
   (`group.length × Math.min(mean, CAP)`) so a long list of moderately rich
   cards beats a few massive containers. Cap is above a rich card's element
   count, below a page-section wrapper's — rolecast/carousel/grid means are
   all <40 so they're unaffected.
2. **Per-card hash classes weren't stripped.** Cards carry
   `KJlVgtRnHLfDQHwLjbGsAsABHadXLGBDvvc`-style tokens. Added `isHashToken`
   to stable-classes (mixed-case, ≥10 chars, no separators) so all cards
   collapse to one stable signature.
3. **BEM over-strip (pre-existing).** The CSS-module pattern
   `__[a-z0-9]{4,}` also ate legit BEM elements like `scaffold-layout__list`,
   merging the wrapper and list containers. Tightened to require a DIGIT in
   the suffix: `__[a-z0-9]*\d[a-z0-9]*` (keeps `Card__a8K2`, keeps
   `scaffold-layout__list`).

**Architectural fix — decouple keyword filtering from the LLM.** The discover
flow trusted the LLM for the itemSelector, and the LLM returned a 1-card
selector. Added `localizeItemSet()` (detect.ts) = lenient modal-stable-leaf
generalization returning a global selector + match count, and
`buildLocalSchema()` (discover.ts) = full schema from detection alone (empty
fields, `source:'local'`). Wired two ways: (a) `discover()` now overrides the
LLM's itemSelector with the local one when local matches MORE elements; (b)
`index.ts attemptDiscover` falls back to `buildLocalSchema` when the LLM call
throws (no key / Failed to fetch / spend cap). Net: the free-text keyword
filter now works with NO API key and regardless of LLM schema quality.
Numeric/named-field filters still use the LLM schema. Added Schema source
`'local'`. Regression fixture `linkedin-search-results.html` (giant wrappers +
hashed cards) + tests 2.1 case and `2.8-local-schema.spec.ts`. Verified the
real bundle via jsdom (all fixtures green) and on live LinkedIn.

**Verification note:** could not run the Playwright runner in the sandbox
(spec discovery > 45s cap), so verified by loading the actual built
`dist/testbed/runtime.js` under jsdom AND by injecting the same logic into the
live page via Claude in Chrome `javascript_tool`. detect/localizeItemSet/
buildLocalSchema/evaluate are pure DOM walks, so jsdom is faithful. The new
Playwright specs still need a host run with browsers.

## 2026-06-04 (later 2) · Keyword filter did nothing — hard-bound to the `snippet` field

User added a keyword and nothing hid. Cause: the panel's free-text phrase
filter was built with `field: 'snippet'` (panel.ts buildFilters) and the
engine treats a missing/empty field as "no information → keep"
(engine.ts:139). LinkedIn job cards have title/company/location but **no
snippet**, so the keyword could never match.

**Fix:** added `ALL_TEXT_FIELD = '*'` sentinel in shared/types.ts; engine
`readField` special-cases it to the item's whole `textContent`
(whitespace-normalized). Panel phrase filter now uses `ALL_TEXT_FIELD`;
UI label changed to "Hide items whose text contains any of:". So a keyword
hides any card mentioning it, regardless of how well the LLM schema's named
fields map. Verified on linkedin-jobs.html via the real bundle: phrase
"Director" → 2/6 cards filtered (the two Director titles), 4 passing.
Named-field filters (numeric `comp`, engine/4.x tests using `field:
'snippet'` on rolecast) are untouched — the sentinel is an additive branch.

**STILL OPEN — schema quality on live LinkedIn ("Detected: list · 1 item").**
On the live jobs search page the panel showed only **1** detected item (a
results list has ~25). So the LLM-discovered/cached schema's itemSelector
matches just one element there. The whole-text filter fix makes filtering
work on whatever IS detected, but precise multi-card detection on the live
results page needs inspection of the real DOM (Claude-in-Chrome not
connected this session; jsdom/synthetic fixtures only). Next: connect
Claude in Chrome (or have user paste a console probe) to see what
detect()/the cached schema land on, then tune detect scoring or the
discover prompt. Re-discover with a hint may also refresh a stale cached
schema.

## 2026-06-04 (later) · "LLM call failed: Failed to fetch" — missing host permission for the provider

After the detect fix, detection worked on linkedin.com/jobs search results
(it found the list and called the LLM) but the SW fetch to the OpenRouter
base URL failed with **"Failed to fetch"** (a network/CORS block, NOT a
401 — a bad key would throw `OpenAI 401: …`).

**Root cause:** the manifest declares only `optional_host_permissions:
["<all_urls>"]` and the Enable button grants just the *page* origin
(`linkedin.com`). The service worker's outbound `fetch` to
`openrouter.ai` therefore had no host permission → MV3 blocks it (CORS) →
TypeError "Failed to fetch". Spend stays 0 because `recordSpend` only fires
on success.

**Fix:** `handleSaveLlmSettings` in `panel.ts` now derives the endpoint
origin (custom `baseUrl`, else the per-provider default mirrored from
llm.ts) and calls `chrome.permissions.request({origins:[`${origin}/*`]})`
**before any await**, so the Save click's user gesture is still active
(request() is required to run under a gesture; it's idempotent so an
already-granted origin resolves without a prompt). Granting an optional
host permission extends the SW's fetch allow-list extension-wide.

**User action after updating:** existing saved key won't have triggered the
prompt, so click **Save** again in the panel → accept the Chrome
permission dialog for the provider host → reload the tab / Re-discover.

**Two follow-ups still open (NOT fixed this session):**
  1. **Enable-without-reload (likely a *second* LinkedIn blocker).**
     `registerContentScripts` only injects on the *next* page load. If a
     user enables NF while already on the jobs tab, `getState` throws and
     the panel shows "No list detected" until they reload (see
     `panel.ts:334` comment). Fix: in `handleEnable`, after register, also
     `chrome.scripting.executeScript({target:{tabId}, files:['content.js']})`
     into the active tab so it works without a manual reload.
  2. **Sandbox build/test note:** mounted `node_modules` holds the macOS
     esbuild binary + no Playwright browsers, and the mount blocks
     `unlink` (so `npm run build`'s `rm(dist)` fails with EPERM). To
     build/test inside Linux: install esbuild/jsdom to `/tmp`, build
     outfiles by overwrite (skip the rm + the static-asset cp of unchanged
     manifest/panel files), `npx playwright install chromium`. Chromium
     launches (~266ms) but the `@playwright/test` runner's spec discovery
     exceeds the 45s per-call cap — verify pure-DOM fns via jsdom instead.

## 2026-05-25 · Slice-3 production wire-up landed (post-Slice-6 add-on)

User reported "No list detected" on youtube.com — confirmed: until
the wire-up landed, content.ts's init() only consulted `pickStubSchema`
which is rolecast-only. Now content's init() falls back to
`tryDiscover()` on any page where no hand-written stub matches. The
flow is detect→fingerprint→distill→`fetchSchemaViaSw` → SW handler
calls `getOrDiscover` → cache hit or LLM call.

Knobs added: SPA-aware retry schedule `[0, 1000, 3000] ms` (YouTube
and similar hydrate after document_idle, so a synchronous detect()
on first try returns null). `mount(schema, itemSet)` extracted so
re-discover from the panel can swap the schema without reloading
the page.

**Known gap (follow-up):** the SW path calls `getOrDiscover` without
passing `opts.spend`, so the cap-check is not enforced *before* the
LLM call — only `recordSpend` fires post-success. A user can blow
past 50/day before the panel surfaces the warning. Cleanest fix:
extend `getOrDiscover`/`DiscoverOpts` to carry a SpendChecker and
pass `chromeStorageSpendChecker()` from the SW handler.

**0.5 spec gotcha:** injecting content.js into panel.html fires
`tryDiscover()` which logs a "discover failed: no-api-key" error
into the panel's console. The 0.5 spec's "no [sieve]
errors" assertion needs to filter that specific line — it's
out-of-scope for 0.5's SW-round-trip contract.

## 2026-05-25 · `panel.bringToFront()` wipes panel state (4.5, repeats elsewhere)

The side panel runs as its own tab. `bringToFront()` fires
`chrome.tabs.onActivated(panel.tab)` which the panel listens to →
calls `refresh()` → `chrome.tabs.query({active:true, lastFocusedWindow:
true})` returns the **panel itself** → `state.origin` becomes null
(it's a `chrome-extension://` URL, not http(s)) → `enabled=false` →
`state.phrases=[]`, `state.savedExists=false`, etc.

Symptom: after a content-driven state update (e.g. the content
script's hydrate just landed and pushed `pageDetected`), the test
calls `env.panel.bringToFront()` and the chip list / saved badge
disappear *immediately after appearing*.

Fix: don't `bringToFront(panel)` after expecting a content-driven
update. Playwright's locator queries work on the page regardless of
focus, so the bringToFront is usually unnecessary. If you *must*
focus the panel (e.g. to drive a keyboard interaction), do it
BEFORE the content event, then check via `waitForFunction` instead
of expecting state-derived UI.

This is the same shape as 0.5's permission-prompt hang: anything
that depends on "what is the active tab" in test mode needs to
account for Playwright's `bringToFront` semantics.

## 2026-05-25 · Direct-child itemSelector loses wrapped items (B.1)

`.joblist > .job` no longer matches a job once the renderer wraps it
into `.joblist > .filt > .job`. The 1.6 memory entry already
captured this for re-discovery; B.1 hit it again for virtualized
re-evaluation. **Convention for any spec that re-runs `findItems`
after the renderer has wrapped:** use a descendant selector
(`.joblist .job` / `#list article.job`). The schema-stub still uses
direct child because the production content script captures items
once and never re-queries (4.6's MutationWatcher splices into the
captured array).

## 2026-05-25 · `renderer.summaries()` returns a live reference (5.7)

`Renderer.summaries()` returns `this.lastSummaries` — the same array
the next `apply()` call replaces and that `setChecking` /
`setRestored` mutate in place (specifically, `summary.state =
'checking' / 'restored'`). Snapshot derived counts BEFORE calling
setChecking; don't keep a `const initial = renderer.summaries()`
across mutations.

Pattern that works:
```ts
const initialPassing = renderer.summaries().filter(s => s.state === 'passing').length;
renderer.setChecking(id, true);
```
NOT this:
```ts
const initial = renderer.summaries(); // live ref!
renderer.setChecking(id, true);
initial.filter(s => s.state === 'passing'); // already mutated
```

## 2026-05-25 · Panel state survives across Playwright `test()` blocks (4.4)

`setupExtEnv()` in `beforeAll` produces a single `env` reused by
every `test()` in the describe. The panel page is the same panel
context throughout, so `state.numeric.op = 'greaterThan'` leaked
from test #1 into test #2 where the test expected the default
`lessThan`. Test #1 last-set the op; test #2 fired `fill('150')`
which fires an `input` event that carries the current op into the
filter — boom, surprise filter shape.

Fix: at the top of each test that touches a stateful UI, RE-PIN
the controls you care about (`select.selectOption('lessThan')`)
even if you think the default is what you want. Cleaner: an
`afterEach` that resets panel state to the test's preconditions.

---

## 2026-05-24 · Playwright workers > 1 flakes the full-extension suite (3.4)

The project's `setupExtEnv()` spawns a full Chromium with a custom
user-data-dir per spec. With `workers: undefined` (Playwright default ≈
cpus/2), multiple full-extension specs race for chromium spawns and
tmp-dir naming — 1.8 + 3.4 intermittently failed in the parallel run
even though both pass in isolation, sequentially, and as a focused
pair. `fullyParallel: false` only orders tests **within** a file;
cross-file parallelism still happens unless `workers: 1`. Pinned
workers:1 in playwright.config.ts. Cost: ~30s on the full run, dwarfed
by reliability gain. Don't unpin without rebuilding setupExtEnv to be
truly contention-free (separate http-server ports already are; the
chromium-spawn timing window isn't).

Symptom to recognize: `npx playwright test 2>&1 | tail -N` reports
"X passed" while the real exit code is non-zero — the pipe through
`tail` swallows playwright's exit code (no `pipefail`), and the
fail-summary lives a few lines above the count. Use `--reporter=line`
+ read the file (not `tail`) when checking suite health.

## 2026-05-24 · `background/llm.ts` lives in background/, runs content-side (3.1)

`extension/background/llm.ts` is the single owner of "what we send to the
LLM" — both the distillation (3.1) and the provider call + Schema parser
(3.2). It's named `background/` because the SW orchestrates the LLM
round-trip, but the **distillation half runs in the content script** (it
dereferences `.classList` / `.children`, which don't exist in MV3 SW).
Module *load* is DOM-safe (TS types erase; the top level has no DOM
access), so sw.ts importing the prompt/provider half in 3.2 won't trip
over the distill exports.

Practical consequence: the content script will import `distill`, run it on
the detected itemSet, then ship the resulting **string** to the SW for the
provider call. The string is the only payload that leaves the device —
keep it that way (no companion fields with content).

## 2026-05-24 · Golden test pattern (3.1)

For frozen-output specs (distillation today, prompt templates likely in
3.2): bootstrap-on-missing + `UPDATE_GOLDEN=1` to refresh. The trap is
that the bootstrap path will happily freeze a *broken* golden if the
extractor was already wrong on first run — so each golden file pairs with
an **independent guard test** that asserts properties of the output
without consulting the golden (e.g. for distill: a denylist of known
fixture content strings + a check that class-name signals survive).
Golden files live at `tests/golden/*.distilled.txt`. The
regenerate-on-PR review reads as a single-file diff.

## 2026-05-24 · Layout fingerprint — modal-shape recursive hash (A.1)

`extension/content/fingerprint.ts`. The hash inputs are deliberately narrow:

  container `tag.classSorted`  |  modal child recursive shape (depth 3)

What's **excluded** (and the reasons, since they all come up again in 6.2):

- **ids / `data-*` / `style` / `aria-*`** — per-item-unique by convention, so
  including them would defeat the modal-mode collapse.
- **Sibling order** — children's recursive shapes are *string-sorted* before
  joining. A page that occasionally swaps two fields (e.g. price↔badge)
  shouldn't change fingerprint.
- **Item count** — taking the mode across the child cluster smooths out
  outliers (sponsored card, "load more" tile) without us needing a separate
  cleanup pass.
- **Non-modal child shapes** — anything not in the dominant cluster is
  ignored entirely.

What's **fragile** and slated for 6.2 ("fingerprint hardening"):

- Utility-class hashes (Tailwind JIT, CSS-in-JS like `css-1xyz3`) are
  hashed *as-is* today. A redeploy that re-mints them changes the
  fingerprint → cache miss → unnecessary LLM call. The 6.2 fix is a
  per-class "looks utility-generated?" filter applied before the sort.
- Hash is FNV-1a 32-bit (sync). Will switch to `crypto.subtle.digest`
  in 6.2 once the surrounding paths are async-friendly.

The 4-strategy comparison + rejection rationale lives in the file header.
Don't re-derive — read it there.

## 2026-05-24 · The renderer's CSS lives in a template literal — no backticks in inline comments

`renderer.ts` keeps its scoped CSS in a single backtick-delimited template
literal (`const STYLES = \`...\`;`). Any backticks inside that string —
including ones inside `/* ... */` CSS comments — close the template early
and the rest of the styles become JS that fails to parse. Lost ~5 min in
2.6 to "Expected ';' but found 'repeat'" because a comment said
`` `repeat(4, 1fr)` ``.

Rule: in this file, write CSS comments with single quotes or no quotes at
all. If you ever need a literal backtick in injected CSS, hoist that
fragment into a separate non-template string.

## 2026-05-23 · Stable item collection — never re-query `itemSelector` after the renderer wraps

`evaluate(schema, items, filters)` is happy to be called with the same item
references repeatedly. The trap is the **content script's re-discovery**:
calling `findItems(schema)` on every `recompute()` re-runs
`querySelectorAll('.joblist > .job')`. After the renderer wraps a filtered
item, it lives at `.joblist > .filt > .job` and the direct-child selector
**no longer matches it** — so removing a filter never unwraps the previously
filtered card. Symptom in Slice 1.6: removing the "unpaid" chip left 4
slivers instead of 3.

Fix in `content/index.ts`: capture `items: findItems(schema)` once at
`init()` and reuse the same array across re-evaluations. Slice 4.6 adds a
MutationObserver to splice in newly-appearing items; until then a static
list is correct because no Slice-1 site adds items dynamically.

A more permissive selector (e.g. `.joblist .job`) would also work but
weakens the schema contract; Slice 2's heuristic detector will want the
direct-child shape preserved.

## 2026-05-23 · Bundling a "testbed" runtime alongside the extension bundles

For tests that exercise content-script code (engine, renderer) without
wanting to spin up the full extension lifecycle, add a *test-only* esbuild
entry → `dist/testbed/runtime.js` that imports the modules under test and
hangs them off `window.__nf`. Specs do
`await page.addScriptTag({ path: TESTBED })` and drive everything via
`page.evaluate`. Keeps the production content script free of test seams.

The full-stack helper lives at `tests/testbed/ext-env.ts`: reuses the 0.6
"bake `<all_urls>` into a tmp manifest" trick to dodge the permission
prompt, then serves fixtures from `fixtures/` over an ephemeral
`127.0.0.1` http server (use `existsSync` pre-check + stream `error →
res.destroy()`, never `writeHead` after a pipe has started — that crashes
the test process with `Cannot write headers after they are sent`).

## 2026-05-23 · Slice-1 message topology: panel ↔ content speaks **directly**

BUILD_PLAN sketches `panel → SW → content` for `upsertFilter` /
`setDisplayMode` / `restoreItem`. Slice 1 cuts the SW out of that loop —
panel uses `chrome.tabs.sendMessage(activeTabId, ...)` directly, content
broadcasts itemStates via `chrome.runtime.sendMessage` (panel listens on
`onMessage`). The SW only does `enableDomain`/`disableDomain`/`ping`. SW
gets re-introduced in Slice 3 when LLM discovery + schemaCache need it.

Why direct: SW relay would be pure forwarding with no state, and Slice-1
filter state already lives panel-local (ephemeral per Decision #13). The
two `PanelToContent` / `ContentToPanel` unions are typed and guarded the
same as the panel↔SW pair — swap is mechanical when Slice 3 lands.

## 2026-05-23 · `chrome.runtime.sendMessage` from a content script reaches **both** the SW and any open extension page

Means content's `pushToPanel(itemStates)` hits the SW listener too. The
SW's `isPanelMsg` guard rejects anything not on its contract → silent
drop, no crash. Worth knowing for any future "I expected my content
broadcast to be panel-only" debugging.

## 2026-05-23 · Granting an extension host permission in headless tests — chosen workaround

After confirming `chrome.permissions.request` hangs and probing four cheap
alternatives (all dead — see entry below), 0.6's test uses a **test-only
manifest variant**: copy `dist/` to a tmpdir, patch `manifest.json` to move
`<all_urls>` from `optional_host_permissions` to `host_permissions`, then
load that. With the perm baked-in:

- `chrome.permissions.request({origins})` for any matching origin resolves
  with `granted=true` immediately (no prompt to hang on).
- `chrome.scripting.registerContentScripts` succeeds for any URL.
- `chrome.permissions.remove` for baked perms **rejects** ("can't remove
  required permissions") — wrap in `.catch(() => undefined)` if the
  production code path calls remove on disable; the SW unregister is the
  source-of-truth disable contract regardless.

Production manifest is unchanged (still `optional_host_permissions:
['<all_urls>']`). The "user actually clicks Allow in the prompt" step is
manual-only and isn't gated by any test.

Rejected alternatives (probed, documented for next time):
- **Preferences pre-seed** with pinned `key`: works in principle but
  requires reverse-engineering the undocumented `Default/Preferences`
  schema, dealing with Secure Preferences MAC verification, and shipping
  a `key` in manifest. Not worth the cost over the test-only manifest.
- **Debug-only SW shortcut**: would still need a real host-perm grant for
  `registerContentScripts` to succeed — moves the problem, doesn't solve.

## 2026-05-23 · Headless Chromium: `chrome.permissions.request` hangs (blocks tests)

Confirmed via spike (`tests/spike-permission-prompt.spec.ts`, now deleted): even
with `channel: 'chromium'` + a real Playwright `page.click()` on a panel button
whose handler invokes `chrome.permissions.request({ origins: [...] })`, the
promise never resolves. After 5 s the test recorded
`[TIMED_OUT — prompt likely hung]` and `chrome.permissions.getAll().origins`
remained `[]`.

Implications:
- Anything that needs a granted host permission in a test (e.g.
  `chrome.scripting.executeScript`, `registerContentScripts` targeting a
  fixture origin) **will not work** via the in-page prompt path.
- 0.5's "round-trip ping" test was written against `panel.html` as the host
  (chrome-extension:// origin already has full `chrome.runtime` access) and
  injects `content.js` via a synthetic `<script>` tag. This trades injection-
  faithfulness for a working wire test; 0.6 owns the real auto-inject gate.
- For 0.6 and any later test that genuinely needs a granted origin, options
  are: (a) pre-seed the user-data-dir `Preferences` file with
  `extensions.settings.<extId>.granted_permissions.explicit_host` (brittle —
  format is undocumented, version-specific, and the extId is volatile unless
  the manifest pins `key`); (b) add a debug-only SW shortcut behind an env
  flag; (c) use CDP `Browser.grantPermissions` (currently scoped to web-API
  permissions like geolocation, not extension host perms — verify before
  relying on it). None is great. Re-spike when 0.6 lands.

## 2026-05-23 · `chrome.tabs.query` returns no `url`/`title` without `tabs` permission

`chrome.tabs.Tab.url` is only populated if the extension has either the
`"tabs"` permission OR matching host permissions for that tab's URL. Since the
"Enable on this site" UX needs to display the origin *before* the user has
granted host permission for it (task 0.6), the panel needs `"tabs"` in
`manifest.json#permissions` — chicken-and-egg otherwise. Added in task 0.4.

`activeTab` would be ideal (scoped, only on user gesture) but it doesn't fire
when we navigate to `panel.html` directly in tests, and the real side-panel
gesture flow isn't wired yet. Revisit if the install-prompt warning for `tabs`
becomes a sticking point at Web Store review.

## 2026-05-23 · Playwright + MV3 extensions: must use `channel: 'chromium'`

By default `chromium.launchPersistentContext({ headless: true })` boots the
**headless_shell** binary, which **does not load MV3 extensions** at all. Symptom
is `context.waitForEvent('serviceworker')` timing out even though
`--load-extension=…` is in `args`.

Fix: pass `channel: 'chromium'` to use the full Chromium build, which supports
the new headless mode that does load extensions.

```ts
await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
```

## 2026-05-23 · ESM package → no `__dirname` in test files

`package.json` declares `"type": "module"`, so `.ts` tests are compiled to ESM
and `__dirname` is undefined. Use:

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
```

## 2026-05-23 · MV3 SW lazy-starts but registers eagerly enough for Playwright

After `launchPersistentContext` returns, `context.serviceWorkers()` may briefly
be empty even though the extension is loaded. Poll with
`context.waitForEvent('serviceworker', { timeout })` instead of asserting
synchronously.
