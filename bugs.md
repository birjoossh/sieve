## These are the bugs and feedbacks identified by human users when using the product

(Status annotations added 2026-06-12 — details per item in tasks.md Progress log and memory.md.)

### Bugs
1. Suggested phrases should be from the current page contents.
   — **FIXED.** "✦ Suggest phrases" now extracts suggestions locally from the detected items (discriminative tokens/bigrams across cards, original casing). No LLM, no network, works without an API key. Specs: tests/4.15-local-suggestions.spec.ts.
   - **User Feedback** Although the suggested phrases comes from the content, it appears very random. Shall we do some apply some apply some very very light weight algo to indetify the top recurring tokens and suggest those. If the LLM is enabled, we can ask teh LLM to suggest
   — **FIXED (2026-06-12), both parts.** (a) Ranking reworked to top-recurring-first: candidates sort by how many cards they appear on (descending), within a [15%, 90%] recurrence band — near-universal tokens are layout chrome and stay out, rare one-offs no longer pad the list. Bigrams that overlap an already-suggested word are dropped as redundant. (b) With an LLM key configured, ✦ now sends the top ~24 local candidates to your provider for curation (pick the filterable topics, drop fragments) and falls back to the local list on any failure — the button always works. Only the candidate tokens travel, never card text (PRIVACY.md updated). Specs: tests/4.15-local-suggestions.spec.ts (ordering, band, redundancy, no-key UI, broken-endpoint fallback UI), tests/4.8-suggestions.spec.ts (curation parsing).

2. Hint provided natural language doesnt work. Eg. (Carousell)[https://www.carousell.com.hk/search/apple%20mac%20mini?addRecent=true&canChangeKeyword=true&includeSuggestions=true&srsltid=AfmBOorh4XfAJy6dd8QhqNAeqjh73_4WuTWXoNzzt90ekxt0vHhhu37U&t-search_query_source=direct_search]
Hint: Price is in the title
Filter: Price > HK 2000
Clicking on Re-discover and later apply filter doesnt work.
   — **FIXED (root cause).** "HK$2,000" parsed as 2 — the number parser stopped at the thousands separator, so "Price > 2000" could never fire. Comma-grouped numbers now parse to their full value. Specs in tests/4.1-predicates.spec.ts. If Carousell still misbehaves after this, re-report — the hint/re-discover path itself was verified separately (#5).
   - **User Feedback** This still doesnt work for me. I tried hint "Price is in the title" and also "Price is formatted as HK $" and later when I apply filter "Price > HK $4000" or "Price > 4000". Nothing is filtered. What do you suggest is the least invasive strategy to solve this.
   — **FIXED (2026-06-12).** Real root cause found: the comma parser was necessary but not sufficient. The panel's numeric filter was **hardcoded to a field literally named `comp`** (the LinkedIn-compensation prototype) with a fixed 0–300 "$k" slider — so on Carousell no hint could ever help: even a perfect LLM schema with a `price` field never lit up the editor, there was no UI to express 4000, and without an LLM key the local schema had no fields at all. Typing "Price > 4000" as a phrase chip does substring matching, which is why nothing filtered. **Least-invasive strategy, implemented:** (a) the content script now detects the price element locally — the consistently currency-formatted element across cards (`HK$4,000`, `$1,234.50`, `€99`…) becomes a `price` number field, no LLM and no hint required; (b) the numeric editor binds to whatever number field the schema has (`price`, `comp`, …) instead of `comp` only; (c) the fixed slider is a free number input ("Hide below/above ___"), so HK$-scale values fit. Works with or without an API key; LLM schemas that omit a numeric field get the same local repair. Specs: tests/4.16-local-price-filter.spec.ts (engine + full UI on a Carousell-shaped fixture, no key configured), tests/4.4-numeric-slider.spec.ts (generalized editor).

3. Color on the Collapse|Hidden toggle is a bit confusing. We should color the side which is actually active at the moment.
   — **FIXED.** Active segment is filled accent + white text with a pressed inset; inactive is ghosted. Light + dark.
   - **User Feedback** With the additional buttons under the Filter sections, I dont think we need "Collapse|Hidden" buttons now. 
   — **FIXED (2026-06-12).** The Collapse|Hide segmented control is removed from the panel. Hidden items always collapse to the placeholder bar (the default everyone used); the renderer still supports full-hide via the `setDisplayMode` message for programmatic use, so nothing was ripped out of the engine. Specs that used the toggle as a "page detected" sentinel now key off the status line's `data-role="page-detected"`. Spec: tests/1.8-display-mode.spec.ts (no toggle rendered + bus path still works).

4. Tried on this website : https://www.facebook.com/marketplace/hongkong/search?query=apple%20mac%20mini
Filter "Macbook" should apply on both "Macbook" AND "Mac Book" but its not
   — **FIXED.** Phrase matching now also compares with all whitespace removed on both sides, so "Macbook" matches "Mac Book" and "mac book" matches "MacBook". Accepted collateral: merged-word matches like "so up" → "soup" (documented in the spec).

5. sometime we see below but there is no re-discover button
   — **FIXED.** The hint input + Re-discover button now render whenever the site is enabled, including the no-schema state the error message describes.

6. Tried on https://www.youtube.com/watch?v=vgZSn10zids with filter "claude" but teh filter were only partially applied.
   — **FIXED + live-verified on that exact URL.** Root cause: the generated item-set selector matched 4 containers and item lookup rooted at the wrong (empty) one — the page mounted with 0 items. Item lookup now picks the container that actually holds the items. Live result: 20 related videos detected, all 16 "claude" matches hidden.

7. Sometimes there is a delay between user adding a filter and it getting applied. Investigate how the latency could be reduced.
   — **INVESTIGATED.** Card-text filters apply in ~32 ms end-to-end (measured). The perceivable delays come from description-based matches (e.g. LinkedIn keywords that only appear in the job description): those need a network fetch per item, and LinkedIn rate-limits to ~20 fetches per window. This path was overhauled (persistent cache, viewport-priority fetching so visible cards resolve first, 429-aware backoff) — visible cards now resolve as fast as the origin allows. Residual delay is origin-imposed, not extension overhead.

### Feedback
1. Set a default provider for OpenAI - https://openrouter.ai/api
   — **SHIPPED.** A "Use OpenRouter" preset button appears next to Base URL when provider = OpenAI; placeholder names both endpoints.

2. Perhaps we can have toogle button into negative, positive or show all filter. Negative filter is default behaviour.
   — **SHIPPED.** 3-way control above the chips: "Hide matches" (default) / "Show only matches" / "Off" (chips retained, filters not applied). Spec: tests/4.14-polarity-toggle.spec.ts.

3. There is no semantic filtering. eg. On (You tube)[https://www.youtube.com/], i used filter "indian mythology" but none of the Indian mythology videos were hidden
   — **ROADMAP.** Needs per-item LLM/embedding classification, which conflicts with the current privacy contract (only a content-free DOM skeleton may leave the browser) and would cost per-scroll LLM calls. Sketch: opt-in "semantic" phrases routed through the BYO-key provider with batched item titles, gated behind an explicit consent + PRIVACY.md update + spend-cap integration. Not started.

4. Sometimes the filters are not immediately appplied. We can supply with a manual apply button to apply the filter. Default behaviour is the current behaviour of auto apply filter
   — **DECLINED for now** (see Bug 7): auto-apply is ~32 ms; a manual apply button would not make description-dependent matches faster since the wait is the origin's rate limit. If the perceived-latency complaint persists, the better fix is showing the existing "⏳ checking" state on cards whose descriptions are still downloading — noted as polish in tasks.md.

