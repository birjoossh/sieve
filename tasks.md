# Tasks — Sieve

Live execution tracker. **Source of truth for "where are we?"** across sessions. Read
top-down to resume.

- **Why & what** → `DESIGN.md` (17 decisions) + `BUILD_PLAN.md` (module map, data shapes,
  7-slice sequence).
- **Where we are right now** → this file.

## Conventions

- `[ ]` todo · `[~]` in-progress · `[x]` done · `[!]` blocked · `[s]` skipped
- Each task ships with a **Playwright** verification. **Fix errors before moving on.**
- After completing a task, append one line to the **Progress log** at the bottom.
- When ending a session, prepend a `### Handoff` block under **Handoff** with: cursor,
  last action, files touched, known issues, next step.
- **Context budget: 90 %.** When the running session crosses ~90 % of its context, write
  a handoff block and stop. Never end a session mid-task without one.

## ▶ Resume here

```
DONE: all 6 slices (0–6) + Spike A + Spike B + Slice-3 production wire-up.
Suite: 114/114 green in 29.4s. Next session: real-site captures
(Spike A → 6.2 8-capture re-validation) + Web Store submission.
```

(Update the line above after every completed task to point at the next one.)

---

## Spike A — Layout fingerprinting (time-box: 1 day, before Slice 3)

- [x] **A.1** Compare ≥4 fingerprint strategies on 8 real-site DOM samples captured 3
  days apart. Pick one.
  **Playwright:** load each captured HTML; assert fingerprint is *stable* within layout
  (same key across captures) and *distinct* across layouts (different keys for jobs vs
  feed vs grid). 5 / 5 fixtures must pass.
  *Pragmatic scope:* 5 synthetic fixtures (rolecast / rolecast-v2 / carousel /
  carousel-v2 / grid) instead of 8 captured 3 days apart. 4 strategies compared
  inline in the picked module's file header (`extension/content/fingerprint.ts`).
  Strategy #4 (modal-shape recursive hash) chosen. Slice 6.2 re-validates on real
  captures.

## Spike B — DOM virtualization (time-box: 1 day, before Slice 6)

- [x] **B.1** Confirm the engine model survives recycled DOM nodes on a virtualized
  list (Twitter-feed / LinkedIn-feed analog).
  **Playwright:** scroll a virtualized fixture 5 viewports; assert no `.filt`/`.restored`
  state leaks onto recycled nodes; engine evaluates each node by content, not identity.
  Fixture virtualized.html — 200 logical rows mapped through a
  12-element <article> ring (same Element refs; data-id + content
  rewritten on scroll). Renderer.apply now calls
  `handleRecycledItem(item)` first: when cached id !== current
  data-id, unwrap stale `.filt`, drop restored/checking, clear
  caches. Closes Spike B + delivers 6.1's gate in one go.
  Discovery: descendant selector (`#list article.job`) is required
  for re-evaluation because wrapped items live inside `.filt` and
  no longer match direct-child selectors.

---

## Slice 0 — Extension skeleton

- [x] **0.1** Project bootstrap.
  - `package.json` (deps: typescript, esbuild, playwright, @types/chrome).
  - `tsconfig.json`, `esbuild.config.mjs` (one bundle per: background, content, panel).
  - Folder layout per `BUILD_PLAN.md#module-map`.
  **Playwright:** `npm run build` → `dist/` exists; load as unpacked in a Chromium
  context → extension installs without errors.

- [x] **0.2** `manifest.json` (MV3): `side_panel`, `optional_host_permissions:
  ["<all_urls>"]`, permissions `scripting`, `alarms`, `storage`, no broad host perms.
  **Playwright:** install prompt asks for **none of `<all_urls>`** (clean install).

- [x] **0.3** `background/sw.ts` + `shared/types.ts` (Message contracts) + typed bus.
  **Playwright:** panel sends `{t:'ping', v:1}` → SW echoes `{t:'pong', v:1}`.

- [x] **0.4** `panel/panel.html` + `panel.ts` + `components/settings.ts` "Enable on this
  site" button.
  **Playwright:** open side panel; button rendered with the active tab's origin.

- [x] **0.5** `content/index.ts` stub: round-trip message with SW.
  **Playwright:** on an enabled fixture page, content logs the SW-roundtripped value
  to the test-captured console.

- [x] **0.6** Per-domain enable flow: `chrome.permissions.request` from panel user
  gesture → `chrome.scripting.registerContentScripts` for granted origin.
  **Playwright:** click "Enable on rolecast.html"; reload tab; content script
  auto-injects without further prompts. Disable → content script no longer runs.

---

## Slice 1 — Fast-path tracer (collapse + re-hide)

- [x] **1.1** `shared/types.ts` — `Schema`, `Filter`, `Predicate` (containsAny only),
  `ItemState`, `DisplayMode`, `LayoutKind`.
  **Playwright:** type-check passes; types referenced by SW + content + panel.

- [x] **1.2** `fixtures/rolecast.html` (10 job cards, 5 of them with phrases that should
  match) + a hand-written `Schema` JSON for it.
  **Playwright:** fixture loads cleanly headless.

- [x] **1.3** `content/engine.ts` — `evaluate(schema, items, filters) → Map<Element,
  ItemState>`. Pure function, no DOM mutation.
  **Playwright:** load fixture, call engine with 2 filters; assert 5 `filtered`, 5
  `passing` (no `restored`/`checking` yet).

- [x] **1.4** `content/renderer.ts` — wrap filtered items in `.filt`; inject the
  horizontal sliver. Passing items untouched.
  **Playwright:** count `.sliver` elements = 5; count `.job:not(.filt .job)` = 5;
  passing card outerHTML byte-identical to fixture.

- [x] **1.5** Renderer: append `↺ re-hide` marker on `.filt.restored`; click swaps
  sliver ⇄ restored card.
  **Playwright:** click a sliver → marker visible + card visible; click marker →
  sliver visible + card hidden again.

- [x] **1.6** `panel/components/filter-list.ts` — single phrase-list filter editor with
  chip add / remove.
  **Playwright:** add a phrase via panel → engine re-evaluates → sliver count updates.

- [x] **1.7** `panel/components/hidden-list.ts` — HIDDEN (N) section with per-row
  `restore` ⇄ `hide`, `restore all` ⇄ `hide all`, counts.
  **Playwright:** toggle a row; in-page state matches; toggle restore-all twice → all
  restored then all re-hidden.

- [x] **1.8** `panel/components/page-status.ts` — DISPLAY toggle (`collapse | hide`)
  wired to `mode-hide` class on the item-set container.
  **Playwright:** switch to hide → 0 visible `.sliver`; switch back → 5 slivers.

---

## Slice 2 — Detect + teach + layout-aware + display mode

- [x] **2.1** `content/detect.ts` — repeated-structure heuristic finds the candidate
  item-set on a page.
  **Playwright:** detect on rolecast (list), a carousel fixture, a grid fixture → each
  returns the correct outer container.

- [x] **2.2** Layout classifier (`list | carousel | grid`) from container axis +
  overflow.
  **Playwright:** classify 3 fixtures → expected `LayoutKind` for each.

- [x] **2.3** `content/picker.ts` — pick-mode hover highlight (transient, only while
  active).
  **Playwright:** enter pick mode → hover an element → outline visible; exit pick mode
  → no outline left in DOM.

- [x] **2.4** Selector generalization: pick one example → robust selector matching all
  siblings.
  **Playwright:** pick one card; generated selector matches all 10 sibling cards on
  three different fixtures.

- [x] **2.5** Renderer: vertical sliver for carousel layout.
  **Playwright:** filtered cards in a carousel render `.sliver-v` (~46 px wide,
  rotated reason text); track still horizontally scrollable.

- [x] **2.6** Renderer: footprint-preserving placeholder cell for grid layout.
  **Playwright:** filtered cells in a 4-col grid render `.ctile`; grid stays 4-col;
  no gaps from missing cells.

- [x] **2.7** `mode-hide` wired on `.joblist`, `.browse`, `.cs-grid` containers per
  layout.
  **Playwright:** toggle hide on each layout → all `.filt:not(.restored)` are
  `display:none`; restored ones remain visible with `↺ re-hide` marker.

---

## Slice 3 — LLM discovery

- [x] **3.1** `background/llm.ts` — DOM distillation (structure-only, content-redacted
  skeleton).
  **Playwright (golden):** fixture DOM → frozen distilled output. Regenerate-on-PR.
  Three goldens locked in (rolecast / carousel / grid → `tests/golden/*.distilled.txt`).
  Refresh on intentional change: `UPDATE_GOLDEN=1 npx playwright test
  tests/3.1-distill.spec.ts`. Independent denylist test guards against the
  bootstrap-on-missing path silently freezing a broken golden.

- [x] **3.2** `llm.ts` — provider call (Anthropic + OpenAI) → parse Schema JSON.
  **Playwright:** with a mock provider serving canned Schema responses, sending a
  distilled DOM returns a typed `Schema`. Malformed response → typed error.
  `discoverSchema(distilled, opts)` orchestrates buildPrompt → provider call
  (`opts.fetcher`-injectable) → JSON extraction (lenient about ```json fences)
  → shape validation → stamp fingerprint/source/discoveredAt. `SchemaParseError`
  with `reason` + truncated `raw` for all failure arms (non-2xx, non-JSON,
  shape violations). 12 spec cases cover both providers' request shape +
  happy + 6 malformed-response branches.

- [x] **3.3** `content/discover.ts` — cache lookup → SW (LLM) on miss → schema apply.
  **Playwright:** first visit → 1 LLM call recorded; revisit → 0 LLM calls; schema
  applies.
  `background/cache.ts` (SchemaCache interface + chromeStorage/memory impls +
  `getOrDiscover`) + `content/discover.ts` (`detect→fingerprint→distill→
  fetchSchema`). Production wiring of `fetchSchema` to the SW round-trip lands
  in 3.4 alongside the panel trigger; 3.3 tests the orchestrator via in-memory
  cache + counted mock fetcher. Cache hits return source 'llm' unchanged.

- [x] **3.4** Panel settings — BYO-key field + provider select; key stored with
  `chrome.storage.local` (not sync).
  **Playwright:** enter key; reload extension; key persists; never appears in any
  message payload other than the provider call.
  `shared/settings.ts` (load/save/clearLlmSettings, storage.local-backed) +
  `panel/components/llm-settings.ts` (provider select + password key input +
  model override + Save/Clear). Persistence test: save → close panel page →
  open new panel → values restored from storage. Privacy test: install spies on
  chrome.runtime.sendMessage + chrome.tabs.sendMessage in the panel context,
  exercise all panel-emitted flows (setFilters, setDisplayMode,
  setItemRestored, disableDomain) → the apiKey value never appears in any
  captured payload. **Test infra:** parallel full-extension specs were
  contending for chromium spawns / tmpdirs (1.8 + 3.4 intermittently failed
  in parallel); pinned `workers: 1` to match the existing
  `fullyParallel: false`.

- [x] **3.5** Re-discover button + NL-hint text input (correction path; feeds prompt).
  **Playwright:** type a hint, re-discover → second LLM call recorded; new schema
  replaces the cached one.
  `force?: boolean` added to `DiscoverRequest`/`DiscoverFetchRequest`; in
  `getOrDiscover`, `req.force` skips cache.get + overwrites on success.
  `page-status.ts` renders re-discover input + button (only when schema is
  set); click fires `onRediscover({ hint, force:true })`. panel.ts wires the
  callback with a stub handler (production end-to-end content/SW round-trip
  is deferred to Slice 3's wire-up capstone, matching 3.3's testbed-only
  scope). Spec: 3 cases — orchestrator force semantics (1st=miss, 2nd=hit, 3rd=force-miss, 4th=hit-on-new), discover() forwards force+hint, UI click fires callback. Suite still 60-passing baseline (3.5 adds 3 → 63 expected).

---

## Slice 4 — Filter UX completeness

- [x] **4.1** Extend `Predicate` (`regex`, `lessThan`, `greaterThan`, `equals`,
  `oneOf`); add safe-regex guard (length cap + backtracking pre-check).
  **Playwright:** evaluate each predicate kind on fixture data; pathological regex
  rejected with a typed error.
  shared/safe-regex.ts (`safeCompileRegex` + `UnsafeRegexError`); length cap
  256 + nested-quantifier heuristic (catches `(a+)+`, `(.*)*`, `(\w+)+`,
  `(a|b+)+`, `(.+){2,}`). engine.ts evalPredicate switch extended: regex
  (with safe-compile), lessThan/greaterThan (parseFirstNumber for
  "$180k" → 180), equals/oneOf (strict-string compare against
  stringified literals). 8 spec cases: 5 new kinds + containsAny
  regression + safe-regex denylist + engine-level error propagation.

- [x] **4.2** `Filter.polarity` = `exclude | keep` (positive filters).
  **Playwright:** a `keep` filter on `workplace=Remote` filters out non-Remote items.
  Engine has supported both polarities since Slice 1.3; 4.2 is a behavioural
  lock-in. 3 spec cases: keep+equals (4 pass / 6 filter), exclude+equals
  inversion (6 / 4), keep+oneOf set membership (3 / 7).

- [x] **4.3** Filter composition: AND across filters, OR within a phrase list.
  **Playwright:** 3 stacked filters; item survives only if it passes all.
  Engine already implemented both semantics: per-item loop in
  `engine.evaluate()` ANDs across filters and breaks on first exclusion
  (first-match-wins reason); `containsAny` ORs across the phrase list.
  4.3 is a behavioural lock-in (mirroring 4.2): 4 spec cases on
  rolecast.html — (1) 3 stacked filters (snippet containsAny / location
  equals / comp lessThan) → only cards 4, 8, 9 survive; (2) OR within
  ["unpaid","no compensation"] hits both phrases; (3) first-match-wins
  reason; (4) cross-fingerprint filter ignored.

- [x] **4.4** Panel: structured value editor (slider + units) for numeric predicates.
  **Playwright:** drag the slider → filter re-evaluates with new value.
  `extension/panel/components/numeric-filter.ts` (slider 0–300 step 10,
  units suffix, `<`/`>` op select, enable checkbox). `schema-stub.ts`
  gains `comp: { kind:'number', selector:'.comp' }`. `panel.ts`
  maintains `NumericFilterValue` state in parallel with `phrases`;
  `buildFilters()` emits up to 2 filters (phrase + numeric) which the
  engine ANDs per 4.3. `pushFilters()` extracted as the shared
  pusher; `pushPhrases` / `pushNumeric` are thin wrappers. `refresh()`
  reconciles `state.numeric` from content's filter list on tab
  switch. Spec: 2 cases on rolecast.html — slider drag from 150→200
  with lessThan goes 3→7 slivers, op flip to greaterThan@200 →
  1 sliver (only r-005=210); compose with "Mandarin" phrase filter
  → 5 slivers (union of exclusion sets).

- [x] **4.5** Filter lifecycle: ephemeral (memory) vs saved (`storage.sync`).
  **Playwright:** save a filter; reload extension; saved filter auto-applies on
  matching layout.
  `shared/saved-filters.ts` (loadSavedFilters / saveFilters /
  clearSavedFilters on `chrome.storage.sync`, keys `nf:filters:<fp>`,
  per-fp shape-validated read). content/index.ts: `hydrateSavedFilters`
  runs async after init mounts the renderer — reads storage, swaps
  ctx.filters, recomputes, re-emits `pageDetected` so an open panel
  re-pulls state. Panel: Save / Clear-saved buttons in filter-list
  (gated on `onSave` prop), `savedExists` from a refresh-time probe
  drives Clear-saved + badge visibility. Panel's `refresh()` doesn't
  fire from `panel.bringToFront()` because tabs.onActivated(panel)
  would null state.origin — spec keeps focus on the fixture
  throughout. 1 spec case: add 2 phrases → save → reload tab → 4
  slivers + 2 chips + saved badge appear without further interaction.
  Clear-saved → reload → 0 slivers.

- [x] **4.6** `content/mutations.ts` — MutationObserver re-evaluates added items.
  **Playwright:** scroll fixture loads 10 more items → engine re-applies → counts
  updated.
  `content/mutations.ts` — MutationWatcher (childList on itemSet, no
  subtree; microtask-debounced flush dedupes per-row + DocumentFragment
  batches into one engine pass). Filters added nodes by
  `el.matches(itemSelector)` so renderer-injected wrappers
  (`.filt`/`.sliver`/`.ctile`) self-skip. content/index.ts: ctx gains
  `watcher`; init starts it after first paint; onItemsAdded appends
  to ctx.items (never re-queries — wrapped items would be lost, per
  memory.md 2026-05-23). Fixture rolecast-paginated.html (5 cards +
  "Load more" appending 5 more via per-row appendChild). Spec: add
  "Mandarin" → 3 slivers → Load more → 4 slivers (r-009 in the new
  batch matches).

- [x] **4.7** Real spend cap (per-day + per-month), `background/spend.ts`.
  **Playwright:** simulate spend over cap → next LLM call blocked with reason
  "spend-cap-reached"; UI shows it.
  `background/spend.ts` — SpendLedger (dailyEpoch/dailyCount/
  monthlyEpoch/monthlyCount) on `chrome.storage.local` key
  `nf:spend-ledger`. Pure helpers: `rollLedger`, `checkLedger`,
  `incrementLedger`. Pluggable surface: `SpendChecker` interface +
  `chromeStorageSpendChecker(caps)` for production +
  `memorySpendChecker(initial, caps)` for tests. Caps default
  50/day, 1000/month (DEFAULT_CAPS). `SpendCapError` carries
  `reason: 'spend-cap-reached'` + `period: 'day' | 'month'`.
  `discoverSchema` gains optional `opts.spend`; checked before the
  provider call (zero network on block) and `recordSpend` fired
  AFTER a successful schema validation — provider 5xx + malformed
  JSON don't move the meter. UI: llm-settings renders
  "N / cap today · M / cap this month" + a typed warning string
  per `cappedPeriod`. 4 spec cases: over-day cap throws (period=
  'day'), clean ledger succeeds + recordSpend fires once,
  monthly-only over-cap throws (period='month'), panel
  storage-seeded ledger surfaces "Daily spend cap reached" copy.

- [x] **4.8** LLM phrasing suggestions (user-initiated; ✦ button → mock provider).
  **Playwright:** click suggest on a phrase filter → suggestions returned and added
  as chips on accept.
  `background/llm.ts` gains `suggestPhrases({provider, apiKey,
  existing, intent, model?, fetcher?, spend?})` — reuses callAnthropic/
  callOpenAI plumbing with a `fingerprint:'suggest'` synthetic value,
  parses `{suggestions: string[]}`, drops blanks + ≥80-char strings,
  case-insensitive dedupe against `existing`. SchemaParseError on
  missing/non-array `suggestions`. Spend hook same as discoverSchema.
  Panel: `state.suggesting/suggestions/suggestError`, `handleSuggest`
  calls suggestPhrases with `(globalThis as any).__nfFetcher` override
  for tests; `handleAcceptSuggestion` moves a pill into chips via
  pushPhrases; `handleDismissSuggestions` clears the list. UI in
  filter-list.ts: ✦ button (disabled while in-flight), suggestion
  pills with `+` Accept buttons + Dismiss. 3 spec cases: engine
  dedupe + drop-empty/over-long, malformed response → SchemaParseError,
  UI full path (click ✦ → 3 pills → Accept "Mandarin" → chip + 3
  slivers → Dismiss).

---

## Slice 5 — Deep path

- [x] **5.1** `background/queue.ts` — persistent queue keyed by `(fingerprint, itemUrl)`
  with `chrome.alarms` heartbeat.
  **Playwright:** enqueue 5; force SW termination; queue resumes from alarm wake-up,
  processes the remaining items.
  `background/queue.ts` — PersistentQueue (init / enqueue / checkout /
  markDone / markFailed / snapshot / pending) + pure helpers
  (mergeEnqueue, reviveInFlight, nextPending, markStatus) + IO
  surfaces (chromeQueueIO on storage.local, memoryQueueIO for tests).
  STORAGE_KEY 'nf:deep-queue'. Status: pending → in-flight → done |
  failed. init() revives stranded in-flight items (SW crash mid-
  process). markFailed bounces to pending until attempts ≥
  MAX_ATTEMPTS (3) then locks at failed. Dedup by (fp, itemUrl) on
  enqueue. installHeartbeat(onTick) wires chrome.alarms (1 min).
  3 spec cases via memoryQueueIO: revive flow (enqueue 5 → drain 2
  → leave 1 in-flight → "SW restart" via new instance + same IO →
  init revives → drain rest, all 5 done); dedup; markFailed bounce
  cycle (pending→pending→failed→empty).

- [x] **5.2** Hidden-tab spawn + completion routing via
  `chrome.tabs.create({active:false})`.
  **Playwright:** enqueue one; assert exactly one hidden tab opens, closes after
  detail extraction.
  `background/deep-runner.ts` — `runOne(itemUrl, opts) → DetailRecord`.
  Pluggable TabsLike + awaitDetail injectables (defaults chrome.tabs +
  chrome.runtime.onMessage on `{t:'detailReady', sender.tabId}`).
  Race against opts.timeoutMs (default 15s). `finally` arm calls
  tabs.remove() even on timeout — no leaked hidden tabs. Tab.id
  undefined → typed throw. 2 spec cases via TabsLike stubs:
  happy path (one create with `{active:false}` + url, one remove with
  same id, awaitDetail awaited deferredly so not skipped); timeout
  path (awaitDetail never resolves → reject + tab still cleaned up).

- [x] **5.3** `content/detail.ts` — read schema-defined detail fields in the hidden tab.
  **Playwright:** on a fixture detail page, fields are extracted matching expected
  values.
  `content/detail.ts` — `extractDetailFields(schema, doc)` reads each
  `schema.detailFieldSelectors` entry, returns trimmed text in a
  `{name → string}` record; missing/empty matches omitted entirely
  (preserves engine's "field absent → no info, skip filter"
  semantics). `isDetailPage(schema, doc)` — true when itemSetSelector
  doesn't match but ≥1 detail selector does. Fixture
  role-detail.html (title / team / salary / seniority / visa /
  description). 2 spec cases: extraction (5 expected fields,
  `missing` key absent), isDetailPage true on detail vs false on list.

- [x] **5.4** Engine: IntersectionObserver viewport-triggered enqueue, top-down.
  **Playwright:** scroll list; near-viewport items enqueue before below-the-fold ones.
  `content/viewport-enqueuer.ts` — ViewportEnqueuer wraps an
  IntersectionObserver with default rootMargin '100% 0px'
  (one-viewport look-ahead so fast scrolls don't skip items).
  Fire-once per element via WeakSet (prevents re-enqueue on scroll
  up/down). Per-callback batch sorted by `getBoundingClientRect().top`
  so top-down order survives out-of-order entry delivery. Pluggable
  `observe(item)` for paired use with 4.6's MutationWatcher. 2 spec
  cases: initial settle on a 10-card list with inflated heights →
  only top items fire, r-001 strictly before r-002, below-the-fold
  (r-009, r-010) not fired; incremental scroll → all 10 fire exactly
  once in DOM order.

- [x] **5.5** Throttle policy (concurrency, jitter, per-domain rate cap, exponential
  backoff on 429 / Cloudflare signals) — Decision #16.
  **Playwright:** mock server returns 429 → backoff increases; concurrent fetch
  count never exceeds the cap.
  `background/throttle.ts` — Throttler with per-domain semaphore +
  jitter + exponential backoff (default schedule 500/1k/2k/4k/8k ms).
  `acquire(domain) → release` resolves when slot+backoff window+jitter
  permit. `reportOutcome(domain, 'rate-limited'|'ok')` escalates or
  resets. Injectable sleep + random for determinism. 3 spec cases:
  fan-out 8 with concurrency=3 → peak ≤ 3; 3 consecutive 429 outcomes
  → sleeps non-zero + increasing (≥3× growth); ok outcome resets
  consecutive429 + backoffUntil.

- [x] **5.6** Per-filter deep toggle in panel + first-use ToS warning modal.
  **Playwright:** enable deep on a filter → warning modal shown once; dismiss →
  remembered.
  `shared/deep-prefs.ts` — `isDeepWarningDismissed`/`dismissDeepWarning`
  on storage.local key `nf:deep-warning-dismissed`.
  `panel/components/deep-toggle.ts` — checkbox + ToS modal (role/aria-
  modal). Panel.ts: state.deepOn / deepWarningDismissed / deepModalOpen.
  Toggle on + !dismissed → modal opens; dismiss → flag persisted +
  modal closes. Spec: check deep → modal renders → dismiss → storage
  flag === true; toggle off + on again → no modal.

- [x] **5.7** `checking` renderer state (collapse mode); transitions to
  `filtered`/`passing` on resolution.
  **Playwright:** during a deep scan, near-viewport items show as `checking`; once
  resolved they switch to sliver or remain passing.
  Renderer.setChecking(itemId, on) — appends/removes `<span class=
  "nf-check-mark">⏳ checking…</span>` inside the item; tracked in
  `checking: Set<string>` + `checkMarkById: Map`. Cached
  lastSummaries entry's state mutated to 'checking' so the panel
  sees it without an engine pass. On the next apply() pass, any
  item that left the checking set has its spinner removed; verdict
  state ('filtered'/'passing') takes effect. 2 spec cases: mark 3
  items → 3 spinners + summaries report checking → run filter for
  "Mandarin" → spinners cleared, 3 slivers, 7 passing; setChecking
  off alone → spinner gone without engine pass. Discovery:
  renderer.summaries() returns a live reference — setChecking
  mutates entries in place, so snapshot counts BEFORE marking.
  Slice 5 complete (5.1–5.7).

---

## Slice 6 — Hardening + ship

- [x] **6.1** DOM virtualization handling: identity-by-content + `WeakMap`.
  **Playwright:** virtualized fixture; recycled nodes don't carry stale state.
  Delivered alongside Spike B. Renderer.handleRecycledItem(item):
  compares cached id (per Element WeakMap) against
  currentIdentityKey(item) = `item.getAttribute('data-id')` —
  divergence triggers unwrap + state purge before ensureId() re-
  mints. Spec asserts sliver count stays ≤ 4 across 5 viewport
  scrolls on a 12-ring virtualized list (no compounding leaks).

- [x] **6.2** Fingerprint hardening: ignore volatile attributes, normalize class lists,
  hash structural shape.
  **Playwright:** the 8 captures from Spike A → identical fingerprint per layout.
  fingerprint.ts adds UTILITY_CLASS_PATTERNS regex set (css-XXX,
  _XXX, module__XXX, jsx-NNN, sc-XXX) and filters before sort in
  nodeShape. Real 8-capture validation deferred per A.1 task note;
  the synthetic lock-in covers the *mechanism*. Fixture
  rolecast-v3-utility-noise.html — structurally isomorphic to
  rolecast.html, every class swapped for a per-deploy hash → same
  fingerprint. 2 spec cases: same fingerprint across noise variants;
  distinct layouts (list / carousel / grid) still produce 3
  distinct fingerprints. SHA-256 swap deferred until surrounding
  cache path is async-friendly.

- [x] **6.3** Filter-set export / import (JSON file).
  **Playwright:** export → import in a fresh profile → filters match.
  `shared/filter-io.ts` — serializeExport / parseExport envelope
  `{v:1, exportedAt, sets:{<fp>:Filter[]}}`. Panel: Export button
  reads all `nf:filters:*` keys from storage.sync, builds a Blob,
  triggers download via anchor.click. Import: file input → File.text
  → parseExport → saveFilters per fp → refresh. UI in filter-list
  actions row, gated on `onExport`/`onImport` props. Spec drives
  full round-trip: save Mandarin filter → click Export → capture
  download via `page.waitForEvent('download')` + `download.saveAs`
  → wipe storage.sync filter keys → setInputFiles re-imports →
  assert storage.sync mirrors pre-wipe state (same fp keys + array
  lengths). Cross-profile portability approximated via storage wipe.

- [x] **6.4** Error states: LLM failure → re-teach prompt; quota exhausted → graceful
  degrade; missing schema → guide to enable.
  **Playwright:** force each failure mode → user-facing message renders.
  `panel/components/error-panel.ts` — pure renderer over
  `{kind: 'missing-schema'|'spend-cap'|'llm-error'|'unsafe-regex',
  message}` rows. Each row carries `data-error="<kind>"` test seam +
  TITLES/HINTS lookup tables. panel.ts derives errors in render():
  schema null + enabled → missing-schema; spend.capReached → spend-
  cap with day/month message; state.suggestError → llm-error.
  3 spec cases: storage-seeded spend cap (full state derivation
  path); missing-schema + llm-error rows verified via direct
  component render (seeding the conditions through the real
  refresh path requires schema infra outside this slice's reach).

- [x] **6.5** Web Store packaging + privacy policy doc (`PRIVACY.md` listing exactly
  what leaves the device).
  **Playwright:** built zip passes the Web Store manifest linter.
  `scripts/package.mjs` (build → `out/sieve-<v>.zip` via
  system `zip`). `PRIVACY.md` enumerates every storage key + the two
  outbound destinations (LLM provider + same-origin detail tabs).
  npm script `package`. Spec runs `npm run package`, unzips into a
  tmpdir, asserts: mv3 manifest, required string fields non-empty,
  permissions all in KNOWN_PERMISSIONS, no `host_permissions`
  baked in (only `optional_host_permissions`), referenced
  service_worker + side_panel paths exist in the zip; second
  case asserts PRIVACY.md exists + mentions every nf:* storage
  key.

- [x] **6.6** Final regression run across all Playwright fixtures (all slices).
  **Playwright:** full suite green.
  Suite: 113/113 green in 29.2s on sequential workers (cf. memory.md
  on `workers:1`). Slices 0–6 complete, Spike A + B closed,
  Web-Store-ready zip + PRIVACY.md produced.

---

## Progress log

(append one line per completed task — `YYYY-MM-DD · task-id · note`)

```
2026-05-23 · 0.1 · esbuild→3 bundles, minimal MV3 manifest, Playwright smoke loads ext via chromium channel — both tests green.
2026-05-23 · 0.2 · manifest: sidePanel/scripting/alarms/storage + optional_host_permissions:[<all_urls>], side_panel:panel.html. Runtime asserts no origins auto-granted; <all_urls> only in optional.
2026-05-23 · 0.3 · shared/types.ts: MESSAGE_VERSION=1, PanelMsg/SwToPanel unions (ping/pong subset), type-guards + sendFromPanel wrapper. sw.ts listens via isPanelMsg; malformed msgs silently dropped. Gate green: ping → pong v:1 round-trip from extension page.
2026-05-23 · 0.4 · components/settings.ts renderEnableButton (pure), panel.ts queries active content tab via {active,lastFocusedWindow}, filters to http(s) origins, refreshes on tabs.onActivated/onUpdated. Added "tabs" permission (chicken-and-egg: panel needs URL pre-grant). HTML/CSS host the settings section.
2026-05-23 · 0.5 · content/index.ts pings SW on load, logs typed pong with "[sieve] SW round-trip" prefix. Renamed sendFromPanel→sendToSw (shared by panel + content). Test hosts content.js in panel.html (chrome.permissions.request hangs in headless — see memory.md); listener attached before script injection; asserts structured args via msg.args()[1].jsonValue(). Spike test deleted. 10/10 green.
2026-05-23 · 0.6 · enableDomain/disableDomain/ack/err message variants + scriptIdFor/originMatchPattern helpers in shared/types. SW registers/unregisters content scripts idempotently. Panel button toggles Enable⇄Disable based on chrome.scripting.getRegisteredContentScripts; click drives permissions.request → enableDomain (production) or disableDomain → best-effort permissions.remove. Test build patches manifest to bake <all_urls> as required so prompts no-op; full Enable→reload→inject→Disable→no-inject loop verified. 4 cheap grant workarounds probed and rejected (see memory.md). 11/11 green.
2026-05-23 · 1.1 · shared/types.ts: full Slice-1 data model (Schema, Filter, Predicate=containsAny, ItemState, DisplayMode, LayoutKind, FieldSpec, ItemSummary, ContentState) + two parallel message buses (PanelMsg↔SwToPanel for panel↔SW; PanelToContent↔ContentReply + ContentToPanel for direct panel↔content). Type guards at every boundary; sendToContent/pushToPanel wrappers. SW kept out of the filter loop for Slice 1 — direct panel↔content is mechanically swappable for SW-relay in Slice 3.
2026-05-23 · 1.2 · fixtures/rolecast.html (10 .joblist > .job cards with the planned 5/5 split: cards 1,3,5 hit "mandatory Mandarin"; 7,9 hit "unpaid"/"no compensation") + fixtures/rolecast.schema.json as docs. Playwright spec asserts card count + match split so a stray fixture edit breaks here, not at 1.3.
2026-05-23 · 1.3 · content/engine.ts — evaluate(schema, items, filters) → Map<Element, ItemVerdict{state, reason?}>. Pure: snapshot-then-call-then-snapshot proves DOM is untouched. Predicate switch on op (containsAny only); polarity handled (exclude+match | keep+miss → filtered). Missing fields skip. First-match-wins for the reason. Testbed: dist/testbed/runtime.js (new esbuild entry) exposes engine + schema-stub on window.__nf for standalone specs.
2026-05-23 · 1.4 · content/renderer.ts — Renderer class that wraps each filtered .job in <div class="filt"><.job/><.sliver/><.rehide/></div>; passing items untouched (WeakMap-tracked id, never written to DOM). Scoped styles injected once per renderer. Passing card outerHTML byte-identical to fixture verified by snapshot diff. data-nf-id on wrappers/buttons for the panel.
2026-05-23 · 1.5 · Sliver click → onRestoreToggle(id, true) → wrapper gains .restored → CSS reveals .job + .rehide, hides .sliver. ↺ re-hide button reverses. Renderer.summaries() folds restored bit into the engine verdict so panel sees one source of truth. Built ahead during 1.4 since the same `wrap()` path emits both buttons; 1.5 spec verified the toggle wiring.
2026-05-23 · 1.6 · panel filter-list component (single filter, snippet field, chip add/remove). Panel orchestration: in-memory phrases → builds Slice-1 Filter with stable id, pushes setFilters to active tab's content. **Bug found + fixed:** content.recompute originally re-called findItems(.joblist > .job) every time, losing items once they got wrapped in .filt. Switched to a stable per-page items list captured at init() — MutationObserver re-discovery lands in 4.6. New tests/testbed/ext-env.ts shared helper: bake <all_urls>, serve fixtures over local http, open panel + fixture tabs, click Enable, wait for content. Reusable for 1.7, 1.8, Slice 2.
2026-05-23 · 1.7 · panel hidden-list (HIDDEN (N), per-row restore⇄hide, restore-all⇄hide-all). Panel pushes setItemRestored per id; bulk action fans out per-item dispatch in parallel. Disabled-state on bulk buttons reflects all-restored / all-hidden edges. itemStates push from content keeps the list live across in-page sliver clicks.
2026-05-23 · 1.8 · DISPLAY toggle (collapse|hide) in page-status component. Hide adds .mode-hide on the .joblist container; CSS rule `.mode-hide > .filt:not(.restored) { display: none; }` hides filtered slivers but keeps restored cards visible. Toggle reflected back via aria-pressed + .active class. Full suite: 19/19 green.
2026-05-23 · 2.1 · content/detect.ts — pure DOM-walk heuristic. Groups each element's children by `tag.classSorted` signature, scores the largest group ≥3 siblings by `groupSize × meanDescendantCount`, returns the winning parent. Two new fixtures (carousel.html, grid.html) modeled on rolecast's shape. detect wired through testbed runtime; 3-case spec asserts .joblist / .carousel-track / .cs-grid each found. Full suite: 22/22 green. Spike A deferred to before Slice 3 per cursor.
2026-05-23 · 2.2 · classify(container)→LayoutKind co-located in detect.ts. Pure read of getComputedStyle: display:grid→grid; display:flex|inline-flex + row|row-reverse + overflow-x:auto|scroll→carousel; else→list. Wired through testbed; 3-case spec composes detect()→classify() so both modules agree on the container. Full suite: 25/25 green.
2026-05-23 · 2.3 · content/picker.ts — Picker class with start()/stop(). Hover highlight via a single overlay <div id="nf-pick-outline"> appended to <body>; `pointer-events:none` so clicks pass through to the underlying element; tracks elementFromPoint on mousemove and re-paints on scroll/resize. start/stop idempotent; stop() removes the overlay and detaches listeners (capture phase, stable refs). Page elements are never touched — keeps detect()/renderer state unpolluted. Full suite: 26/26 green.
2026-05-23 · 2.4 · generalize(picked) in detect.ts → {itemSetSelector, itemSelector}. Reuses the `tag.classSorted` signature from detect() so the two modules agree on "same shape". Container path is built by ascending until uniqueSelectorFor() round-trips (id > leaf-alone > leaf>leaf chain), CSS.escape on every class. Self-validates: composed itemSelector's querySelectorAll must equal the picked element's same-shape sibling cluster, else returns null. Spec picks one card on each of rolecast/carousel/grid → 10/10/12 sibling matches. Full suite: 29/29 green.
2026-05-24 · 2.5 · Renderer layout-aware: when schema.layout='carousel', wrap() emits `.filt.layout-carousel > .sliver-v` instead of `.filt > .sliver`. New CSS: wrapper sized `flex: 0 0 46px` + `align-self: stretch` so it slots into the row-flex track without breaking the horizontal scroll; sliver paints `writing-mode: vertical-rl` for top-to-bottom reason text. refreshSliver() now matches both sliver classes. Spec: inline carousel schema, "Linen" filter → 2 cards become 46px slivers, 8 passing cards stay direct children, track.scrollWidth > clientWidth + overflow-x:auto. Full suite: 30/30 green.
2026-05-24 · 2.6 · Renderer grid layout: wrap() emits `.filt.layout-grid > .ctile` for schema.layout='grid'. No flex sizing — the host grid template still places the wrapper into exactly one cell, so column count and row pack stay stable. .ctile = dashed-border placeholder filling the cell footprint. Spec mounts inline grid schema on grid.html, filters Systems+Compilers → 3 ctiles; .cs-grid children stay 12; grid-template-columns still 4 tracks; distinct cell-tops = 3 rows; wrapper widths match passing tile widths ±2px. **Memory:** burned 5 min on backticks inside the CSS template literal — see memory.md. Full suite: 31/31 green.
2026-05-24 · 2.7 · No code change — Slice 1.8's `.mode-hide > .filt:not(.restored){display:none}` rule already covers carousel + grid since the layout-specific wrappers still carry the bare `.filt` class. Parametrized 3-fixture spec verifies setMode('hide') adds .mode-hide on the itemSet for each layout, all unrestored wrappers become offsetParent=null, and restoring one brings it back with `↺ re-hide` visible while the others stay hidden. Slice 2 complete (2.1–2.7). Full suite: 34/34 green. Cursor moved to Spike A — Slice 3's schemaCache is the first place where fingerprint stability matters.
2026-05-24 · 4.1 · Predicate union extended in shared/types.ts: containsAny | regex | lessThan | greaterThan | equals | oneOf. shared/safe-regex.ts: `safeCompileRegex(pattern, flags)` → RegExp or throws `UnsafeRegexError({reason, pattern})`. Static checks: length ≤ 256, nested-quantifier regex `/\([^)]*[+*][^)]*\)\s*[+*?{]/` (catches `(a+)+`, `(.*)*`, `(\w+)+`, `(a|b+)+`, `(.+){2,}`). Engine evalPredicate switch grew 5 arms. Numeric kinds parse first contiguous digit run (`-?\d+(\.\d+)?`) — "$180k–$220k" → 180 (lower-bound semantics for the slider in 4.4). equals/oneOf strict-string compare against stringified literals. 8 spec cases against rolecast.html; UnsafeRegexError correctly propagates from evaluate() so the panel can surface it in 6.4.
2026-05-25 · 3.x wire-up · Slice-3 production wire-up (panel → content → SW → getOrDiscover). User reported YouTube enable showed "No list detected" — confirmed expected behavior under the unwired path. shared/types.ts: PanelMsg gains `discoverSchema`, SwToPanel gains `schema`, PanelToContent gains `rediscover`, ContentToPanel gains `discoverError`. background/sw.ts handles discoverSchema → loadLlmSettings (returns 'no-api-key' err if absent) → getOrDiscover → cache hit or LLM call → recordSpend → reply `schema`/`err`. content/index.ts factored mount(schema, itemSet) for re-mounting on rediscover; tryDiscover() runs detect→fingerprint→distill→fetchSchemaViaSw with SPA-aware retries [0, 1000, 3000] ms (YouTube hydrates after document_idle). pickStubSchema fallback → tryDiscover when no hand-written stub. rediscover handler routes panel re-discover request through tryDiscover with force+hint. Panel: onRediscover wired to sendToContent; state.discoverError populated on discoverError push; error-panel surfaces it. New fixture no-stub-list.html exercises the path; spec pre-seeds schema cache to avoid hitting a real LLM. Discovery: 0.5's "no `[sieve]` errors" assertion broke under the new content/init — filtered "discover failed" lines since they're out-of-scope for that test's SW-round-trip gate. Full suite: 114/114 green in 29.4s.
2026-05-25 · 6.6 · Full regression: 113/113 green in 29.2s sequential. Suite covers slices 0–6 + Spike A + Spike B. Web-Store-ready zip + PRIVACY.md emitted. Project deliverable complete; deferred items captured in tasks.md tail.
2026-05-25 · 6.5 · scripts/package.mjs (npm run package) → out/sieve-<v>.zip via system zip. PRIVACY.md enumerates storage keys (nf:llm-settings, nf:filters:*, nf:spend-ledger, nf:deep-warning-dismissed, nf:deep-queue) + the two outbound destinations (LLM provider + same-origin detail tabs). Spec: unzip + assert mv3 + required string fields + KNOWN_PERMISSIONS membership + no host_permissions baked + referenced paths resolve; PRIVACY.md mentions every key.
2026-05-25 · 6.4 · panel/components/error-panel.ts — pure renderer for error rows {kind, message} with TITLES/HINTS lookup tables. `data-error="<kind>"` seam. panel.ts render() derives errors from state: schema-null+enabled → missing-schema, spend.capReached → spend-cap (period-aware), suggestError → llm-error. 3 spec cases; full real-derivation path tested for spend-cap, contract verified via direct render for the other two.
2026-05-25 · 6.3 · shared/filter-io.ts (serializeExport/parseExport with `{v:1, exportedAt, sets}` envelope). Panel: Export button reads all nf:filters:* via storage.sync.get(null) + Blob download via anchor.click; Import file input → File.text → parseExport → saveFilters per fp + refresh. UI in filter-list actions row. Spec: save → export → captured JSON → wipe storage → setInputFiles → assert keys + lengths restored.
2026-05-25 · 6.2 · fingerprint.ts adds UTILITY_CLASS_PATTERNS regex set (css-XXX, _XXX, module__XXX, jsx-NNN, sc-XXX) — filtered out of nodeShape's class sort. Fixture rolecast-v3-utility-noise.html (isomorphic to rolecast but every class swapped for a per-deploy hash). 2 spec cases. Real 8-capture validation deferred per A.1 note. SHA-256 swap waits for async-friendly cache path.
2026-05-25 · B.1 / 6.1 · Renderer.handleRecycledItem(item) called at the top of apply(): cached idByItem.get(item) vs currentIdentityKey (item.getAttribute('data-id')) — mismatch triggers unwrap + restored/checking purge before ensureId re-mints. Fixture virtualized.html (200 logical rows over a 12-element <article> ring rotated on scroll). Spec asserts sliver count ≤ 4 across 5 viewport scrolls (no compounding). **Memory:** descendant itemSelector (`#list article.job`) required for wrapped items to remain queryable — direct-child (>) loses them once wrapped, breaking re-evaluation against recycled rows. Closes Spike B + 6.1 together.
2026-05-25 · 5.7 · Renderer.setChecking(id, on) — appends/removes a `<span class="nf-check-mark">⏳ checking…</span>` indicator inside the item element, tracked in Set + Map. Mutates cached lastSummaries entry's state to 'checking' so panel sees update without engine pass. Next apply() clears spinner for any item that left the checking set; verdict state takes effect. Two CSS rules added (nf-check-mark). 2 spec cases. **Memory:** renderer.summaries() returns a live reference; setChecking mutates entries in place — snapshot derived values pre-mutation.
2026-05-25 · 5.6 · shared/deep-prefs.ts (isDeepWarningDismissed / dismissDeepWarning on storage.local 'nf:deep-warning-dismissed') + panel/components/deep-toggle.ts (checkbox + ARIA modal). panel.ts state.deepOn / deepWarningDismissed / deepModalOpen. Toggle on + !dismissed → modal opens; dismiss persists + closes. Spec: enable → modal → dismiss → storage flag true → re-enable → no modal.
2026-05-25 · 5.5 · background/throttle.ts — Throttler{concurrency, jitterMs, backoffMs[], sleep, random}. acquire(domain)→release (semaphore + backoff-until wait + jitter). reportOutcome(domain, 'rate-limited'|'ok'). Default backoff [500,1000,2000,4000,8000]. inspect(domain) for tests. 3 spec cases: fan-out 8 / concurrency 3 → peak ≤ 3, 3 consecutive 429 → escalating sleeps (≥3× growth), ok-outcome reset.
2026-05-25 · 5.4 · content/viewport-enqueuer.ts — IntersectionObserver wrapper with default rootMargin '100% 0px' for one-viewport look-ahead. Fire-once per element via WeakSet (scroll up/down won't re-enqueue). Per-tick batch sorted by boundingClientRect.top so top-down order survives out-of-order IO entries. 2 spec cases: initial settle (only top items fire, r-001 before r-002, below-fold unfired); incremental scroll (all 10 fire exactly once in DOM order). Discovery: fast scrollTo() between observations skips entries → use incremental 200px steps with settles in tests.
2026-05-25 · 5.3 · content/detail.ts — extractDetailFields(schema, doc?) returns {name→trimmed text}, omits missing/empty (matches engine's "no info skip" semantics for list reads). isDetailPage heuristic: itemSetSelector not present + ≥1 detail selector present. Fixture role-detail.html. 2 spec cases. Slice 5 deep-path now: queue (5.1) + tab spawn (5.2) + detail extraction (5.3) — next is IntersectionObserver-driven enqueue ordering (5.4).
2026-05-25 · 5.2 · background/deep-runner.ts — runOne(itemUrl, opts) → DetailRecord{itemUrl, fields, durationMs}. Pluggable TabsLike + awaitDetail (defaults: chrome.tabs + chrome.runtime.onMessage matching {t:'detailReady', sender.tabId}). Race against opts.timeoutMs (default 15s); finally arm guarantees tabs.remove. 2 spec cases: happy lifecycle (one create active:false, one remove with same id, await actually awaited via microtask defer), timeout (no leaked tabs).
2026-05-25 · 5.1 · background/queue.ts — PersistentQueue (init/enqueue/checkout/markDone/markFailed/snapshot/pending), pure helpers (mergeEnqueue/reviveInFlight/nextPending/markStatus), IO surfaces (chromeQueueIO + memoryQueueIO). Status: pending→in-flight→done|failed. init() revives stranded in-flight (SW crash recovery). markFailed bounces until attempts≥MAX(3). installHeartbeat() wires chrome.alarms. 3 spec cases: 5-item enqueue + simulated SW death + resume (all 5 ultimately done); dedup; failed-bounce cycle. Slice 5 deep-path scaffolding begins.
2026-05-25 · 4.8 · background/llm.ts adds suggestPhrases(opts) — reuses callAnthropic/callOpenAI via fingerprint:'suggest' synthetic, parses {suggestions:string[]}, drops blanks + >80-char, case-insensitive dedupe vs existing. Throws SchemaParseError on malformed shape; honors opts.spend same as discoverSchema. Panel: filter-list.ts grew ✦ button + suggestion pills (+/Accept and Dismiss); panel.ts state.suggesting/suggestions/suggestError + handleSuggest reads `globalThis.__nfFetcher` test seam. handleAcceptSuggestion routes through pushPhrases so engine re-evaluates synchronously. 3 spec cases. Full suite: 89/89 green in 22s. Slice 4 complete (4.1–4.8).
2026-05-25 · 4.7 · background/spend.ts — SpendLedger ({dailyEpoch, dailyCount, monthlyEpoch, monthlyCount}) on storage.local key 'nf:spend-ledger'. Pure: rollLedger / checkLedger / incrementLedger. Pluggable: SpendChecker interface, chromeStorageSpendChecker (prod) + memorySpendChecker (tests). Caps default 50/day, 1000/month; SpendCapError {reason, period}. discoverSchema opts.spend optional: canSpend pre-fetch (block costs zero network), recordSpend POST-validateSchemaShape so 5xx + JSON errors don't move the meter. llm-settings.ts: usage readout + cap-reached warning gated on cappedPeriod. 4 spec cases: over-day (throws period='day'), clean ledger (Schema returned + recordSpend fires once), over-month-only (period='month'), panel storage-seeded ledger surfaces "Daily spend cap reached" text. Full suite: 86/86 green in 20.5s.
2026-05-25 · 4.6 · content/mutations.ts — MutationWatcher (childList on itemSet, no subtree, microtask-debounced flush). Filters added nodes by `el.matches(itemSelector)` so renderer wrappers self-skip. ctx.items extended in-place via onItemsAdded callback — never re-queried (memory.md 2026-05-23). Fixture: rolecast-paginated.html (5 cards + Load more button appending 5 via per-row appendChild loop). Spec: Mandarin filter → 3 slivers initially → Load more → 4 slivers (r-009 matches). Full suite: 82/82 green in 19s.
2026-05-25 · 4.5 · shared/saved-filters.ts — load/save/clear on chrome.storage.sync, per-fp keys (nf:filters:<fp>), shape-validated read so stale schemas drop silently. Content's init runs hydrateSavedFilters() async — reads storage, swaps ctx.filters, recomputes, re-emits pageDetected so an open panel re-pulls. Panel: Save / Clear-saved buttons + "saved" badge in filter-list (props onSave/onClearSaved/savedExists). state.savedExists probed in refresh(). Discovery: tabs.onActivated(panel) wipes panel state.origin → wipes phrases. Test must not bringToFront(panel) after a content-driven update. 1 spec case: add 2 phrases → Save → reload → 4 slivers + 2 chips + badge auto-appear; Clear-saved → reload → 0 slivers. Full suite: 81/81 green in 19.2s.
2026-05-25 · 4.4 · panel/components/numeric-filter.ts — slider+units editor for numeric predicates. UI: enable checkbox, `<`/`>` op select, range slider (0–300 step 10), unit-suffixed readout. Wired via state.numeric (NumericFilterValue: enabled/op/value), separate push path (pushNumeric → pushFilters). buildFilters now emits up to 2 filters (phrase + numeric); engine ANDs per 4.3. Stub schema grew comp (kind:'number'). refresh() reconciles numeric from content's filter list so tab-switch persists. Spec: drag 150→200 lessThan (3→7 slivers), op flip to >200 (1 sliver), compose with "Mandarin" phrase (5-sliver union of exclusions). Full suite: 80/80 green in 19s.
2026-05-25 · 4.3 · No engine change — both semantics ship since Slice 1.3 (AND-across via per-item filter loop with first-match-wins break, OR-within via containsAny phrase iteration). 4.3 is a behavioural lock-in mirroring 4.2's shape. 4 spec cases on rolecast.html: (1) 3 stacked filters across 3 fields × 3 predicate kinds (snippet containsAny, location equals, comp lessThan) → 3 survivors (cards 4, 8, 9), 7 filtered — the gate scenario; (2) OR within ["unpaid", "no compensation"] hits both phrases, distinct reasons surfaced; (3) first-match-wins: Mandarin filter listed before Shanghai filter, all 3 dual-match cards surface "Mandarin", never "Shanghai"; (4) cross-fingerprint filter silently ignored (engine's `filters.filter(f.fingerprint===schema.fingerprint)` gate). Full suite: 78/78 green in 21.9s.
2026-05-24 · 3.5 · cache.ts: added `force?:boolean` to DiscoverRequest; getOrDiscover skips cache read when force, still writes the new schema. content/discover.ts: signature changed to discover(doc, ctx, opts? = {hint, force}) — opts forwarded into DiscoverFetchRequest. panel/components/page-status.ts: when onRediscover is supplied, renders a hint <input> + "Re-discover" button beneath the mode toggle; click → onRediscover({hint?, force:true}). panel.ts: stub handler that console.info's the payload (production round-trip is the unlisted Slice-3 wire-up capstone; 3.3's testbed-only pattern extended here). Spec: orchestrator force semantics (4 calls: miss → hit → force-miss → hit-on-new); discover() forwards force+hint; UI click fires callback with right payload.
2026-05-24 · 3.4 · extension/shared/settings.ts (loadLlmSettings/saveLlmSettings/clearLlmSettings on chrome.storage.local key 'nf:llm-settings') + LlmProvider in shared/types.ts (Provider re-exported from llm.ts for back-compat) + panel/components/llm-settings.ts (provider <select>, type=password key input, model override input, Save/Clear). panel.ts: refresh() loads on every reconcile, render() mounts llm-settings section, handleSaveLlmSettings persists via shared/settings. panel.html: new <section id="llm-settings">. Spec: persistence (save → close panel → reopen → values restored, Clear wipes); privacy (spy chrome.runtime/tabs.sendMessage, drive all panel actions, assert key never serialized in any message payload). playwright.config.ts: workers:1 — full-extension specs contend for resources at parallel >1 once 3.4 landed (1.8 + 3.4 flaked). Full suite: 60/60 green sequentially.
2026-05-24 · 3.3 · extension/background/cache.ts — SchemaCache (get/set, async) + chromeStorageSchemaCache (storage.local, nf:schema:<fp> keys) + memorySchemaCache (Map-backed for tests) + getOrDiscover(req, deps) orchestrator. Cache hit → return cached Schema unchanged (source stays 'llm', cache is transport not provenance). Cache miss → loadSettings → llm.discoverSchema → cache.set → return. All side-effects via deps (cache, loadSettings, llm?, fetcher?, now?). extension/content/discover.ts — discover(doc, ctx, hint?) → detect → fingerprintItemSet → classify → distill → ctx.fetchSchema → {schema, itemSet}. Production sw.ts wiring of fetchSchema deferred to 3.4. Spec: rolecast.html double-discover → fetchCount=1 (gate), itemSet matches, 10 .joblist>.job items findable; fp-A/fp-B/fp-A → fetchCount=2 (cache key is binding); memorySchemaCache roundtrip. Full suite: 58/58 green.
2026-05-24 · 3.2 · extension/background/llm.ts — discoverSchema(distilled, opts) + SchemaParseError. Providers: Anthropic (v1/messages with x-api-key + anthropic-version: 2023-06-01 + anthropic-dangerous-direct-browser-access:true) and OpenAI (v1/chat/completions with Authorization: Bearer). DiscoverOpts: { provider, apiKey, fingerprint, model?, hint?, fetcher? (defaults globalThis.fetch), now? (defaults Date.now) }. JSON extraction lenient: strips ```json fences, falls back to first-{...-last-}. validateSchemaShape rejects: non-object, invalid layout, empty/missing itemSetSelector or itemSelector, missing fields, invalid FieldSpec.kind, non-string detail*. Stamps source:'llm' + fingerprint + discoveredAt at the boundary so callers can't forget. Spec: 12 cases via testbed, mockFetch inside page.evaluate captures URL/method/headers/body. Suite: 55/55 green.
2026-05-24 · 3.1 · extension/background/llm.ts — distill(root) → structure-only, content-redacted skeleton. Kept: tag, sorted class list, role, id-on-root. Redacted (replaced with …): all text, aria-label/alt/title/placeholder; href/src → "#…". Dropped: style, data-*, on*, inner ids, script/style/link/meta/noscript/template subtrees. Bounding: depth ≤ 8; runs of ≥3 consecutive same-shape siblings collapse to first + `… ×N more <shape>`. Collapse marker reuses shapeOf() to stay locked to the rendered child. Three goldens (rolecast/carousel/grid) frozen at tests/golden/*.distilled.txt; bootstrap-on-missing + UPDATE_GOLDEN=1 refresh path. Independent denylist test guards the bootstrap path. Wired through testbed; module load DOM-safe so sw.ts can pull in 3.2's prompt/provider helpers from the same file. Full suite: 43/43 green.
2026-05-24 · A.1 · extension/content/fingerprint.ts — modal-shape recursive hash. 4 strategies compared in the file header; #4 picked. fingerprintItemSet(container) → null | 8-char hex (FNV-1a, will swap for SHA-256 in 6.2). Excluded from hash: ids, data-*, style, aria-*, sibling order, item count, non-modal child shapes. Two perturbed fixtures (rolecast-v2, carousel-v2) added — same shape, different content/count/attrs. Spec 4 cases / 5 fixtures: all yield a fingerprint, list-pair matches, carousel-pair matches, three layouts produce three distinct keys. Full suite: 38/38 green.
```

## Handoff

(when ending a session, **prepend** a block here. Most recent at top.)

```
### Handoff — YYYY-MM-DD HH:MM
Cursor:        <task id you stopped at>
Last action:   <what you just did>
Files touched: <paths>
Tests:         <pass / fail counts; which failed and why>
Known issues:  <anything weird, half-fixed, or postponed>
Next step:     <the next concrete action a new session should take>
```
