# Sieve — Design

A browser extension that adds user-defined filtering — especially **negative** filters —
to the rendered results lists of *any* website, beyond the filters the site itself provides.

_Design decisions captured from a grilling session on 2026-05-22._

## Problem

Websites expose limited built-in filters. Users routinely need extra ones, especially
*negative* filters the site never offers — e.g. on LinkedIn job search, "exclude jobs whose
description contains 'mandatory Mandarin language'." Two hard facts shape the whole design:

1. The text you want to filter on is often **not in the results list** — a LinkedIn job card
   shows title/company/location/snippet; the full JD lives on the detail page.
2. The extension must be **website-agnostic** — no per-site code, ever.

## Core architecture

- **Browser extension**, Chrome/Chromium (Chrome + Edge), Manifest V3, for v1. Firefox is a
  v2 port.
- **Two filtering engines:**
  - **Fast path** — filter on text/fields already present in the results-list DOM. Instant,
    universal, free, offline.
  - **Deep path** — opt-in, per-filter. Fetches detail-page content for filters that need it
    (e.g. full JD). Slow, resource-bounded; the user consciously opts in per filter.
- **Schema discovery via LLM.** An LLM reads a distilled, content-redacted DOM skeleton and
  returns a **filter schema** (selectors + field types) for that page layout. Discovery only —
  the LLM never evaluates individual items.
- **Deterministic matching engine.** All per-item filtering is local: phrase/substring and
  regex for text, comparisons for structured fields. Instant, free, offline, private.
- **No backend.** Everything runs in the extension. Schemas cache locally per layout.
- **Generality = data, not code.** The codebase has zero per-site branches. A site's
  "adapter" is just a cached JSON schema the LLM produced — structurally identical for every
  site. Note: generic *code* does not buy generic *runtime success* on the deep path —
  LinkedIn-class sites actively resist programmatic detail fetching.
- **Minimal, scoped page footprint.** The extension never touches naturally-passing content
  or the page's theme. It renders into the page only on items it has *acted on*: in collapse
  mode a *filtered* item becomes a minimal sliver, and a *restored* item keeps a small
  in-page *re-hide* marker; in hide mode filtered items render nothing. The side panel
  carries the full review surface — a **Hidden (N)** list with a restore ⇄ hide toggle.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Text source for content filters | **Hybrid** — fast path on list DOM; opt-in deep-fetch for detail content |
| 2 | How filters are discovered | **LLM-in-the-loop** reads the DOM and returns the schema |
| 3 | LLM cadence | **Per-user runtime, local cache only** — no backend, no schema sharing |
| 4 | LLM scope | **Discovery only** — matching is deterministic and local |
| 5 | LLM endpoint | **User's own API key (BYO key)** |
| 6 | Generality | **Fully website-agnostic** — schemas as data, no per-site code |
| 7 | Deep-fetch mechanism | **Hidden background tab** — open detail URL, render, read DOM, close |
| 8 | Deep-path timing | **Lazy, viewport-triggered, throttled**, queued, cached by item URL, processed top-down |
| 9 | Text-match semantics | **Phrase list (default) + per-filter regex toggle**; LLM can suggest phrasing variants |
| 10 | Primary UI surface | **Browser side panel** (`chrome.sidePanel`) — the primary UI; in-page rendering limited to collapse-mode slivers + the transient teach picker |
| 11 | Discovery trigger | **Auto-run** the LLM on every plausible list page, **within user-enabled domains** |
| 12 | Filtered-item rendering | **Display-mode setting** — *collapse* (default): filtered → in-place sliver, restored → in-page re-hide marker; *hide*: `display:none`. Panel HIDDEN list (restore ⇄ hide) in both modes |
| 13 | Filter lifecycle | **Ephemeral by default; one-click "save"** promotes to persistent + auto-reapply |
| 14 | Mis-detection correction | **Click-to-teach** — content-script picker; user clicks the real item/field; a deterministic selector patches the schema (no LLM call) |
| 15 | Host permissions | **Optional / per-domain** — clean install, no broad permission; one-time per-domain grant enables the extension there |
| 16 | Deep-path throttling | **Bot-protection policy** — low concurrency, jittered delays, per-domain rate cap, ToS warning (LinkedIn / Cloudflare class) |
| 17 | Collapse-mode rendering | **Layout-aware** — list → horizontal sliver; carousel → vertical sliver; grid → footprint-preserving placeholder cell |

The click-to-teach picker (#14) also doubles as a fallback path: if LLM discovery fails
outright, or the user has no API key, they can hand-teach a schema element by element. It
appears only transiently while the user is actively teaching.

Supporting conventions (asserted, not separately grilled):

- Engine supports both **negative** (exclude-if-match) and **positive** (keep-if-match)
  predicates — same engine, inverted boolean. Emphasis and naming stay on negative.
- **Composition:** multiple filters AND together; a single text filter's phrase list ORs.
- **Storage:** saved filter definitions in `chrome.storage.sync` (small, cross-device);
  schema cache in `chrome.storage.local` / IndexedDB (larger, device-specific).
- **Sharing:** file export/import of filter sets (no backend involved).
- Newly-inserted items (infinite scroll) are re-filtered via a `MutationObserver`.

## Auto-run cost guardrails (required)

Decision #11 spends the user's API key without per-page consent, so:

- The **per-domain grant** (#15) is the primary consent gate — auto-run only ever fires on
  domains the user explicitly enabled, and enabling a domain *is* the informed consent.
- The local "is this a list page?" heuristic must be **high-precision** — its false-positive
  rate *is* the cost of auto-run.
- A user-set **spend cap** (per day/month) on top of the per-domain gate.
- Caching means steady-state cost trends to zero; spend is front-loaded onto new layouts.

## Implementation risks (no design decision pending — to handle during build)

1. **Layout fingerprint stability.** The cache key must be stable across content changes,
   distinct across layouts, and survive A/B tests and minor markup churn. Non-trivial.
2. **DOM distillation.** Need a reliable step that strips a page to a structure-only,
   content-redacted skeleton before it goes to the LLM — for privacy and token cost.
3. **Deep-path ToS / account risk.** Hidden-tab loads use the user's real session (helps),
   but volume/timing can still trip bot detection and risk the user's account. The extension
   should warn when a deep filter is enabled.
4. **MV3 service-worker lifecycle.** The hidden-tab queue/throttle lives in a service worker
   that can be killed anytime — the queue must persist (storage / `chrome.alarms`).
5. **Site virtualization.** Modern lists recycle DOM nodes as you scroll; the engine must
   handle nodes being added/removed/reused, not just appended.
6. **Filter-driven reflow.** Both modes reflow the page as items are filtered (collapse
   less than hide); with the deep path this happens as you scroll. Mitigated by top-down
   processing, inherent to filtering.
7. **Selector generalization for click-to-teach.** Turning one clicked element into a robust
   selector that survives content changes is its own small problem.
