# Negative Filter — Implementation Plan

Concrete implementation plan for the design in `DESIGN.md` (17 decisions). Seven vertical
tracer-bullet slices — each demoable end-to-end. This plan adds the module map, data
shapes, and per-slice deliverables that `DESIGN.md` deliberately leaves out.

## Sequencing principle

- **Vertical, not horizontal.** Every slice cuts through content script → engine → side
  panel and produces something runnable on a real page.
- **Fake the expensive thing first.** Slice 1 hard-codes a schema so the engine ships
  before the LLM exists. Slice 2 lets a human produce schemas (click-to-teach), so the
  schema *format* is validated by real use before an LLM has to generate it.
- **Defer the dangerous thing.** The deep path touches ToS and account risk — it lands
  in Slice 5, once everything around it is stable.

## Task model & verification

Each slice is broken into atomic tasks tracked in **`tasks.md`** — the live execution
log. This plan is *why* and *what*; `tasks.md` is *where we are*.

- **Atomic tasks.** Each one is small enough to land in one focused sitting and ships
  with a **Playwright test** as its done-criterion. The "Demo gate" lines below describe
  the user-visible outcome; the precise gating tests live in `tasks.md`.
- **Test-and-fix.** Run the task's Playwright test; if it fails, fix it before moving to
  the next task. No advancing on red.
- **Session-resumable.** Progress is appended to `tasks.md` after each completed task,
  and ending a session writes a `## Handoff` block so a new session (or another agent)
  can pick up with no prior context — read `tasks.md` top-down, find the
  `▶ Resume here` cursor, continue.
- **Context budget: 90%.** Before context runs out, write a handoff block and stop.

Spike work (fingerprinting, virtualization) sits in `tasks.md` too — gated by Playwright
fixtures that exercise the failure modes they're trying to head off.

## Module map

```
extension/
  manifest.json                     MV3 config: side_panel, optional_host_permissions:
                                    ["<all_urls>"], scripting, alarms, storage.
  shared/
    types.ts                        Schema · Filter · Predicate · Message contracts ·
                                    ItemState · LayoutKind
    constants.ts                    Mode names, channel names, default thresholds
  background/                       service worker (MV3 — can be killed any time)
    sw.ts                           entry; message bus; permission grants;
                                    chrome.scripting.registerContentScripts
    cache.ts                        schemaCache (storage.local) · filterStore
                                    (storage.sync) · detailCache (storage.local)
    llm.ts                          DOM distillation + BYO-key LLM discovery call
    queue.ts                        deep-fetch queue (storage-persisted + chrome.alarms),
                                    hidden-tab spawn, throttle, jitter, backoff
    spend.ts                        API spend tracking + per-day/month cap
  content/                          injected per granted origin
    detect.ts                       heuristic: list / carousel / grid? candidate
                                    repeating-item set? layout classifier
    discover.ts                     cache lookup → SW (LLM) if miss → schema delivery
    engine.ts                       apply schema + filters → tag each item with
                                    ItemState (passing | filtered | restored | checking)
    renderer.ts                     inject the layout-appropriate sliver + the re-hide
                                    marker; never touch passing items
    mutations.ts                    MutationObserver: re-evaluate added/recycled nodes
    picker.ts                       click-to-teach picker (transient, user-initiated)
    detail.ts                       deep-path field reader (runs in the hidden tab the
                                    background queue spawned)
  panel/                            chrome.sidePanel UI
    panel.html · panel.css · panel.ts
    components/
      conn-status.ts                enabled-domain status + connection dot
      page-status.ts                detected / schema / footprint / mode toggle / fields
      filter-list.ts                active filters + editor; new-filter UI
      hidden-list.ts                HIDDEN (N) list; restore ⇄ hide; restore/hide all
      footer.ts                     deep-scan progress + spend cap
      settings.ts                   BYO key, spend cap, per-domain enable, display mode
```

## Data model

```ts
type LayoutKind = 'list' | 'carousel' | 'grid';
type ItemState  = 'passing' | 'filtered' | 'restored' | 'checking';
type DisplayMode = 'collapse' | 'hide';

interface Schema {
  fingerprint: string;                // stable hash of layout (Slice-6 hardened)
  layout: LayoutKind;                 // chosen renderer
  itemSetSelector: string;            // outer container (.car-track, .cs-grid, etc.)
  itemSelector: string;               // repeating item within the set
  fields: Record<string, FieldSpec>;
  detailLinkSelector?: string;        // anchor → detail page URL (deep path)
  detailFieldSelectors?: Record<string, string>;
  source: 'llm' | 'taught' | 'cached';
  discoveredAt: number;
}

interface FieldSpec {
  kind: 'text' | 'number' | 'date' | 'enum' | 'flag';
  selector: string;
  deep?: boolean;                     // value lives only on the detail page
}

interface Filter {
  id: string;
  fingerprint: string;                // bound to a schema
  polarity: 'exclude' | 'keep';
  field: string;                      // one of schema.fields
  predicate: Predicate;
  deep: boolean;                      // opt-in deep evaluation
  saved: boolean;                     // ephemeral (memory) vs persistent (storage.sync)
}

type Predicate =
  | { op: 'containsAny'; phrases: string[]; regex?: boolean }
  | { op: 'lessThan'; value: number }
  | { op: 'greaterThan'; value: number }
  | { op: 'equals'; value: string | number | boolean }
  | { op: 'oneOf'; values: string[] };

interface Settings {
  apiKey?: string;                    // BYO; never leaves the device except to provider
  displayMode: DisplayMode;
  spendCapDailyCents: number;
  spendCapMonthlyCents: number;
  enabledDomains: string[];           // also reflected in granted host permissions
}
```

## Message contracts (sketch)

```ts
// panel → sw
type PanelMsg =
  | { t: 'enableDomain'; origin: string }      // triggers chrome.permissions.request
  | { t: 'discover'; tabId: number; hint?: string }
  | { t: 'setDisplayMode'; mode: DisplayMode }
  | { t: 'upsertFilter'; filter: Filter }
  | { t: 'restoreItem'; tabId: number; itemId: string; restored: boolean };

// sw → content
type SwToContent =
  | { t: 'applySchema'; schema: Schema }
  | { t: 'applyFilters'; filters: Filter[] }
  | { t: 'enterPicker' };

// content → panel
type ContentToPanel =
  | { t: 'pageDetected'; layout: LayoutKind; count: number; fingerprint: string }
  | { t: 'itemStates'; items: Array<{ id: string; state: ItemState; reason?: string }> };
```

## Slices

| # | Slice | Demo gate | Decisions |
|---|-------|-----------|-----------|
| 0 | Extension skeleton | Install → enable a domain → panel ⇄ content talk | 6, 10, 15 |
| 1 | Fast-path tracer (collapse) | Hard-coded schema → type a phrase → sliver + re-hide round-trip | 1 (fast), 4, 9, 12, 13 |
| 2 | Detect + teach + layout + display mode | Teach on any list / carousel / grid; toggle collapse ⇄ hide | 11, 14, 17 |
| 3 | LLM discovery | Land on a fresh enabled-domain list → schema auto-appears | 2, 3, 5, 11 |
| 4 | Filter UX completeness | Regex, multi-filter, save, infinite scroll, spend cap | 9, 13 + conventions |
| 5 | Deep path | Opt-in deep filter → hidden-tab scan resumes after SW death | 1 (deep), 7, 8, 16 |
| 6 | Hardening + ship | Virtualization, fingerprint robustness, export/import, Web Store | — |

### Slice 0 — Extension skeleton
**Goal:** smallest installable extension with the *real* permission model.
**Build:**
- `manifest.json`: side_panel; `optional_host_permissions: ["<all_urls>"]`; permissions
  `scripting`, `alarms`, `storage`.
- `background/sw.ts`: panel ⇄ content ⇄ sw bus; `chrome.permissions.request` from a panel
  user gesture; `chrome.scripting.registerContentScripts` for each granted origin.
- `panel/panel.html` + `components/settings.ts`: an "Enable on this site" button.
- `content/` stub: logs "hello" and round-trips a message.
**Defer:** filtering, schema, LLM, deep path.
**Demo gate:** install with a clean prompt; click "Enable on rolecast.io"; the panel and
the content script can talk.

### Slice 1 — Fast-path tracer bullet (collapse rendering)
**Goal:** the deterministic engine end-to-end with the LLM stubbed and one layout.
**Build:**
- `shared/types.ts` — Schema, Filter, Predicate (containsAny only), ItemState.
- One hand-written schema JSON for a chosen test list page (loaded in code).
- `content/engine.ts` — `evaluate(schema, items, filters) → Map<Element, ItemState>`.
- `content/renderer.ts` — wrap each filtered item in `.filt`; layout = list ⇒ horizontal
  sliver. For `restored`, append a `↺ re-hide` marker. Passing items: untouched.
- `panel/components/filter-list.ts` — single filter editor (phrase chips).
- `panel/components/hidden-list.ts` — restore ⇄ hide per row + restore-all ⇄ hide-all.
- `panel/components/page-status.ts` — DISPLAY toggle hooked up (collapse only exposed).
**Defer:** detection, layout classification, LLM, deep, regex, structured predicates,
hide mode.
**Demo gate:** on the test page, type "mandatory Mandarin" → matching cards collapse to
slivers; click a sliver → card + `↺ re-hide`; click the marker → back to sliver; panel
HIDDEN row also toggles.

### Slice 2 — Heuristic detection + click-to-teach + layout-aware + display mode
**Goal:** real schemas without the LLM — schema format validated by humans first.
**Build:**
- `content/detect.ts` — heuristic repeated-structure detection; classify layout
  `list | carousel | grid` from container axis + overflow.
- `content/picker.ts` — hover highlight in pick mode; selector generalization from one
  picked element; emits a Schema and writes to `schemaCache`.
- `content/renderer.ts` — layout-aware (Decision #17): horizontal sliver in lists,
  vertical sliver in carousels, footprint-preserving placeholder cell in grids.
- `panel` — DISPLAY toggle (collapse | hide) wired; `mode-hide` class on the item-set
  container; page-status shows "schema: by teaching."
**Defer:** LLM.
**Demo gate:** unfamiliar list / carousel / grid site — heuristic flags it; click-teach
the item + a field; the Slice-1 filter works unchanged; flip DISPLAY to hide → in-page
slivers vanish; restored items still show with their `↺ re-hide` marker.

### Slice 3 — LLM discovery
**Goal:** auto-run discovery replaces manual teaching as the default.
**Build:**
- `background/llm.ts` — DOM distillation (structure-only, content-redacted skeleton);
  provider call with the user's BYO key; parse Schema JSON.
- `content/discover.ts` — cache lookup; on miss, request distillation + LLM via SW;
  apply on response.
- `panel/components/settings.ts` — BYO-key field, provider select.
- `panel/components/page-status.ts` — "Schema by LLM"; re-discover button; re-discover-
  with-hint text input (feeds prompt for correction).
- `background/spend.ts` — stub counter (real cap in Slice 4).
**Defer:** strict spend cap, fingerprint hardening.
**Demo gate:** land on a fresh enabled-domain list → schema appears with zero clicks;
revisit → instant from cache, no LLM call fired.

### Slice 4 — Filter UX completeness
**Goal:** the filter model is feature-complete.
**Build:**
- `shared/types.ts` — extend Predicate (regex, lessThan, greaterThan, equals, oneOf);
  Filter.polarity = `exclude | keep`.
- Safe-regex guard (length cap + backtracking pre-check, e.g. `safe-regex`).
- `panel/components/filter-list.ts` — regex toggle, structured value editor (slider +
  unit), KEEP ONLY variant, LLM-suggested phrasings (sent through SW; user-initiated).
- Composition: AND across filters, OR within a phrase list.
- Ephemeral (in-memory) vs saved (`storage.sync`) filter lifecycle.
- `content/mutations.ts` — MutationObserver re-evaluates added items.
- `background/spend.ts` — real daily + monthly cap, with month reset.
**Demo gate:** stack three filters (text + structured + positive); save one; scroll an
infinite list and watch new items get filtered; reload → the saved filter auto-applies.

### Slice 5 — Deep path
**Goal:** opt-in detail-content filtering.
**Build:**
- `background/queue.ts` — persistent queue keyed by `(layoutFingerprint, itemUrl)`;
  hidden-tab spawn (`chrome.tabs.create({active:false})`); after tab `complete`, inject
  `content/detail.ts` to read schema-defined detail fields; close tab; write
  `detailCache`. Persistence: `storage.local` + `chrome.alarms` heartbeat so the queue
  resumes after SW termination.
- `content/engine.ts` — IntersectionObserver enqueues items as they near the viewport,
  top-down ordering; tagged `checking` until resolved.
- **Throttling (Decision #16):** low concurrency (1–2 tabs), jittered delays, per-domain
  rate cap, exponential backoff on Cloudflare/403/429 signals.
- `panel/components/filter-list.ts` — per-filter `deep` toggle; first-time ToS warning
  modal disclosing what the deep path does.
**Demo gate:** enable a deep filter on a JD-content phrase → cards show `checking` →
resolve top-down to slivers; kill the SW mid-scan → queue resumes via alarm wake-up.

### Slice 6 — Hardening + ship
**Goal:** production readiness.
**Build:**
- Virtualization handling: identity-by-content + `WeakMap` so recycled DOM nodes don't
  lose state; re-evaluate on attribute changes.
- Fingerprint hardening: stable across content changes and minor A/B churn; ignore
  volatile attributes, normalize class lists, hash structural shape.
- Filter-set file export/import (JSON).
- Error states: LLM failure → "re-teach" prompt; quota exhausted → graceful degrade.
- Web Store: privacy policy enumerating exactly what leaves the device (only the
  distilled DOM to the user's chosen LLM provider); manifest hardening; screenshots.
**Demo gate:** survives a virtualized list without leaking or double-filtering; passes
Web Store review.

## Two spikes before Slice 3

Both are flagged in `DESIGN.md` as the highest-uncertainty risks. Time-box each to ~a day
*before* committing the Slice 3 architecture:

1. **Layout fingerprinting** — can a key be stable across content changes, distinct
   across layouts, and survive A/B tests? Get this wrong and Slice 3 either thrashes the
   user's API key or serves stale schemas.
2. **DOM virtualization** — confirm the engine's node model survives recycled DOM nodes
   on a real virtualized site, before the engine ossifies around an append-only
   assumption.

## Cross-cutting concerns

- **Message contracts** are typed and versioned (`v: 1` on every message). Add `v: 2`
  in parallel during a migration.
- **No telemetry.** No backend by design. The only network traffic the extension
  initiates is to the user's chosen LLM provider with the user's key.
- **Tests.**
  - Unit: predicate evaluation; selector generalization; fingerprint hash;
    DOM-distillation reducer.
  - Integration: engine + renderer on a fixture DOM; queue persistence across forced SW
    termination; MutationObserver round-trip.
  - Golden: frozen LLM-distillation prompts and expected Schema outputs (regression
    guard against prompt drift).
- **Performance budget.** Engine evaluation ≤ ~50 ms per 100 items; renderer paint
  ≤ 16 ms per state transition; SW message round-trip ≤ 30 ms.
- **Accessibility.** Side panel is keyboard-navigable; slivers are focusable; the
  `↺ re-hide` marker has an accessible name; restore ⇄ hide buttons have ARIA labels.
- **Privacy doc.** Exactly what leaves the device: the *distilled* DOM (structure +
  redacted text placeholders) to the user's chosen LLM provider, only on cache miss.
  Deep-fetch traffic stays inside the browser (the user's own session tab).

## Implementation risks

The seven risks listed in `DESIGN.md` apply — they're not decision-pending, they're
build-time work. The two highest are time-boxed as spikes above. The rest (DOM
distillation, deep-path ToS, SW lifecycle, virtualization, filter-driven reflow, selector
generalization) are absorbed into Slices 3–6.

## First runnable thing

Slices 0 + 1 together are the tracer bullet: an installed extension that collapses real
items on one page from a hard-coded schema, with the full in-page restore ⇄ hide loop
and the panel's HIDDEN list. Everything after replaces a fake with the real component
without changing the slice's shape.
