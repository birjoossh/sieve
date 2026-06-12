# todo.md — Security / Performance / Reliability audit (2026-06-12)

Scope: full read of `extension/` (background, content, panel, shared) on branch
`dev` @ `bb3d177`. Severity: **P0** fix before store submission · **P1** fix
soon · **P2** hardening / polish.

**Resolution 2026-06-12: all 25 items fixed** (bugs → security → performance).
Typecheck + full Playwright suite green (155 passed). Spec updates that went
with deliberate behavior changes: 4.1 (rejected regex now disables one filter,
not the pass), 5.7 (checking indicator is `[data-nf-checking]`, no inserted
node), 4.7 (spend epochs are local-calendar). One deviation noted inline below
on the heal-observer item.

Verified clean, for the record: no `innerHTML`/`insertAdjacentHTML` sinks
anywhere (panel renders page-derived labels/reasons/suggestions via
`textContent`); LLM payloads route through `distill()` redaction; user regex
goes through `safeCompileRegex`; saved-filter reads shape-validate; the API
key stays in `storage.local` and never crosses the message bus.

## Security risks

- [x] **P0 — Credentialed auto-fetch of page-controlled URLs.**
  `content/deep-text.ts` (`itemDetailUrl` generic fallback + `fetchDetailResult`
  with `credentials: 'include'`): when a phrase filter is active, the scanner
  automatically GETs the *first anchor href of every card*, with the user's
  cookies, no user interaction. A page (or user-generated content on it) can
  plant anchors at state-changing GET endpoints — logout links, one-click
  actions ("?action=delete"), tracking beacons — and the extension fires them
  silently for every rendered card. Fix: restrict the generic fallback to
  same-origin URLs, send `credentials: 'omit'` unless same-origin, and skip
  URLs with query strings that look action-like; keep the hardcoded
  LinkedIn `jobs-guest` endpoint as the only cross-path special case.

- [x] **P1 — No sender validation on privileged SW messages.**
  `background/sw.ts` `onMessage`: `enableDomain` / `disableDomain` /
  `discoverSchema` / `suggestPhrases` are accepted from *any* extension
  context, including content scripts running inside arbitrary granted pages.
  Defense-in-depth for a compromised renderer: `enableDomain` can register
  the content script on any origin; `discoverSchema`/`suggestPhrases` can
  burn the user's LLM spend with attacker-shaped payloads. Gate the
  registration messages on `sender.tab === undefined` (panel/SW pages only)
  and rate-limit/attribute the LLM messages to the sender's tab.

- [x] **P1 — API key sent over whatever scheme the baseUrl has.**
  `background/llm.ts` `callAnthropic`/`callOpenAI`: `baseUrl` is user-typed
  and unvalidated; an `http://` proxy URL ships the key (twice: `x-api-key`
  **and** `Authorization: Bearer`) in cleartext. Enforce `https:` (allow
  `http://localhost`/`127.0.0.1` for Ollama/vLLM) at save time in
  `panel.ts handleSaveLlmSettings` and again at call time.

- [x] **P2 — Provider response bodies flow into UI error strings.**
  `llm.ts` puts up to 200 chars of the raw HTTP body into `Error.message`,
  which travels to the panel and `console.error`. Rendered via `textContent`
  so not XSS, but provider errors can echo request fragments — keep, but
  truncate harder and strip to a known reason set before display.

- [x] **P2 — `tabs` permission is broad for what's used.**
  `manifest.json` requests `tabs` (full URL access on every tab) to get
  `changeInfo.url` in the SPA relay. Store review will flag it. Document the
  justification for the listing, and consider scoping the relay to tabs whose
  origin is enabled (the registration table already knows them).

- [x] **P2 — API key at rest is plaintext in `storage.local`.**
  Accepted baseline for MV3 (no OS keychain access), but make it explicit in
  PRIVACY.md, and make sure no future debug/export path (e.g.
  `handleExportFilters`, which already reads `storage.sync` only — good)
  ever does `storage.local.get(null)`.

## Performance improvements

- [x] **P1 — Regex filters recompile per item, per pass.**
  `content/engine.ts` `evalPredicate` calls `safeCompileRegex` inside the
  per-item loop — a 500-item list with one regex filter compiles 500 RegExps
  per recompute, and recompute runs on every mutation batch. Compile once per
  filter before the item loop (also fixes the throw-behavior bug below).

- [x] **P1 — `detect()` rescoring is O(page) on every retry.**
  `content/detect.ts` walks every element and calls
  `getElementsByTagName('*').length` per child per parent — effectively
  Σ(subtree sizes) ≈ O(n × depth). It runs up to 3 seeded times plus once per
  mutation batch (≥750ms apart) for 60s on undetected pages. On 10k+-node
  SPAs this is real jank. Compute descendant counts in one post-order pass
  and reuse, or memoize per element within a single `detect()` call.

- [x] **P1 — Per-item text re-read for every filter.**
  `engine.ts` `readField` re-reads and re-normalizes `item.textContent` once
  per applicable filter per item (the `ALL_TEXT_FIELD` path also re-squashes
  whitespace). Cache the normalized card text per item for the duration of
  one `evaluate()` call.

- [x] **P1 — Unbounded in-memory description cache.**
  `deep-text.ts` `sharedTextCache` keeps every fetched description string for
  the lifetime of the page (module-level, shared by design). LinkedIn
  descriptions are ~5–20 KB each; an afternoon of paginating leaks tens of
  MB. Add an LRU cap (~200 entries).

- [x] **P1 — Renderer maps pin dead DOM nodes.**
  `renderer.ts`: `itemById` (Map, strong refs), `detachedFiltered`,
  `companionsByItem`, and `lastVerdicts` all retain Elements that
  virtualization has long since dropped from the document. Same for
  `ctx.detailText` in `content/index.ts` (Map keyed by Element; pruning only
  filters `ctx.items`, never the map). Sweep disconnected entries on each
  `apply()`, or key off WeakRef/WeakMap where iteration isn't needed.

- [x] **P2 — Panel refreshes on every tab's every URL change.**
  `panel.ts` `chrome.tabs.onUpdated` listener triggers a full `refresh()`
  (content round-trip + 4 storage reads + re-render) for *any* tab update in
  any window. Filter to `tabId === state.activeTabId`.

- [x] **P2 — Storage never pruned.**
  Schema cache (`nf:schema:<fp>`, one key per fingerprint, forever) and the
  deep queue (`nf:deep-queue`, `done`/`failed` items kept forever, whole
  array rewritten per operation) grow without bound in `storage.local`. Add
  a TTL/LRU sweep on SW startup; drop `done` queue items at heartbeat.

- [x] **P2 — Heal observer churn.**
  `renderer.ts` `installHealObserver` watches `attributes` on the entire
  item-set subtree; busy SPAs (LinkedIn re-rendering rows) schedule a heal
  microtask per mutation burst that iterates all filtered items. Cheap per
  pass, but consider only observing when `renderMode === 'detached'` and
  debouncing beyond a microtask.
  _Done partially: attribute observation is now detached-mode-only (wrap
  mode watches childList only). The microtask debounce stays — the 6.7
  gate ("self-heal … within a tick") pins it, and a heal pass is cheap._

## Hidden bugs

- [x] **P0 — Panel state is clobbered by background tabs.**
  `panel.ts` `chrome.runtime.onMessage` does not check `sender.tab.id`
  against `state.activeTabId`. With the extension enabled on two tabs, the
  inactive tab's `itemStates`/`pageDetected` pushes overwrite the HIDDEN
  list, item counts, and trigger refreshes for the wrong tab. Same gap in
  `sw.ts`'s badge handler is handled correctly (per-tab) — mirror that in
  the panel by recording and comparing the sender tab id.

- [x] **P0 — One malformed selector kills the whole pipeline.**
  `engine.ts` `findItems` (`root.querySelectorAll(schema.itemSelector)`) and
  `readField` (`item.querySelector(field.selector)`) are not try/caught, and
  these selectors come from the LLM or imported filter sets. A single invalid
  selector throws out of `evaluate()` → `recompute()` →
  `handlePanelMessage('setFilters')`, so the content script never replies and
  the panel surfaces a generic "port closed" error. Wrap with the same
  `safeCount`-style guards used elsewhere and treat a bad field selector as
  "field absent".

- [x] **P1 — A rejected regex disables all filtering instead of one filter.**
  `engine.ts`: `safeCompileRegex` throwing `UnsafeRegexError` inside
  `evalPredicate` aborts the entire `evaluate()` pass (every filter, every
  item) and, as above, the typed error never reaches the panel as such.
  Compile filters up front; surface per-filter errors; keep evaluating the
  remaining filters.

- [x] **P1 — Filter import: no validation, silent quota failures.**
  `shared/filter-io.ts` comments claim "the panel routes imports back through
  saveFilters() which runs the same shape validation" — `saveFilters()`
  validates nothing (validation only happens on *read*). `panel.ts`
  `handleImportFilters` also doesn't catch `saveFilters` rejections, so a
  `storage.sync` quota error (8 KB/item, 100 KB total) silently truncates an
  import with no user feedback. Validate with `isFilterShape` on import,
  catch and surface write errors, and report counts via the existing
  `FilterImportResult` (currently defined but unused).

- [x] **P1 — Spend caps are not user-configurable despite the design saying so.**
  `background/spend.ts` header: "Caps come from LlmSettings (4.7 extension)"
  — but `shared/settings.ts` has no cap fields and `sw.ts` constructs
  `chromeStorageSpendChecker()` with `DEFAULT_CAPS` unconditionally. Either
  land the settings fields or fix the comment; today the 50/day cap is
  hard-coded.

- [x] **P1 — Daily spend rollover happens at UTC midnight, not local.**
  `spend.ts` `epochDay` floors epoch ms (UTC); a user in UTC+8 gets their
  daily budget reset at 8am. Use the local calendar day if the cap is meant
  to be user-comprehensible.

- [x] **P1 — (Dormant deep-scan path; bugs to fix before wiring it up.)**
  `background/queue.ts`, `deep-runner.ts`, `throttle.ts`,
  `content/viewport-enqueuer.ts`, `detail.ts`, `picker.ts` are not imported
  by any entry point yet. Before slice 5 is wired:
  - `deep-runner.ts` `defaultAwaitDetail`: the `onMessage` listener is never
    removed when the 15s timeout wins the race — leaks one listener per
    timed-out run, and a late `detailReady` from a recycled tabId can resolve
    the wrong item.
  - `deep-runner.ts` `runOne`: no URL scheme/origin validation before
    `tabs.create({url})` — queue items derive from page DOM; restrict to
    http(s) and the list page's origin.
  - `queue.ts` `installHeartbeat` adds a fresh `onAlarm` listener on every
    call — call it twice in one SW life and every tick drains twice.
  - `queue.ts` `checkout()` is load-then-save with no versioning — two
    concurrent drains (alarm tick + message-triggered) can check out the same
    item.
  - `throttle.ts` `acquire()` sleeps the backoff *while holding* the
    semaphore slot, so one cooled-down domain request blocks the slot for
    other waiters of the same domain (intentional for politeness, but the
    jitter sleep does the same even on healthy domains).

- [x] **P2 — Checking-spinner breaks the byte-identical contract.**
  `renderer.ts` `setChecking` appends `.nf-check-mark` directly into the item
  subtree. On React-managed lists this is exactly the foreign-node insertion
  the detached mode exists to avoid (reconciler may strand or duplicate it),
  and a passing item that was briefly "checking" no longer snaps back
  byte-identical if removal races a re-render.

- [x] **P2 — `stripHtml` entity handling is partial.**
  `deep-text.ts`: `&[a-z]+;` misses numeric entities (`&#39;`) and turns
  meaningful ones into spaces (`AT&amp;T` → "AT T"), so phrases containing
  `&` or apostrophes silently fail to match against fetched descriptions.
  Decode the common named/numeric entities instead of blanking them.

- [x] **P2 — `localizeItemSet` falls back to a count of the *bare leaf*.**
  `detect.ts`: when the scoped selector loses cards, the fallback
  `itemSelector = leaf` is document-wide; a leaf like `div.card` can match
  lookalikes outside the container. `findItems` re-scopes via `bestRoot`,
  which mostly saves it, but the repair comparison in `discover.ts`
  (`local.count > countMatches(...)`) is comparing document-wide counts and
  can prefer an over-broad local selector over a correct LLM one.

- [x] **P2 — Companion-row cache goes stale.**
  `renderer.ts` `companionsOf` caches the sibling walk on first computation
  (`companionsByItem`); rows inserted later (live-updating tables) hide/show
  with stale companion sets until the item is unfiltered once.
