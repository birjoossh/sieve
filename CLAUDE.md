# CLAUDE.md — Negative Filter

Guidance for Claude Code when working in this repo. This file is loaded into every
session — keep it concise and project-specific. Generic advice belongs nowhere.

## What this is

Chrome MV3 extension (TypeScript + esbuild + Playwright). Hides items from list /
carousel / grid pages on arbitrary sites using user-defined "negative" filters. Three
surfaces: **content script** (per-origin, DOM-bound), **side panel** (UI), **background
service worker** (LLM proxy, cache, registration). LLM is gated and optional — see
"Why the LLM" below.

## Read these first, in order

1. `tasks.md` — live execution cursor. Find `▶ Resume here`. **Source of truth for
   "where are we?"** across sessions.
2. `memory.md` — lessons learned, site-specific gotchas (LinkedIn DOM rebuilds,
   virtualization, deep-text fetching). Read before touching site stubs or detection.
3. `BUILD_PLAN.md` — module map (binding), data shapes, 7-slice sequence.
4. `DESIGN.md` — 17 numbered decisions. Reference when a task cites a decision number.
5. `PRIVACY.md` — what may and may not be sent to the LLM provider. Load-bearing for
   any change to `extension/background/llm.ts` (especially `distill()`).

## Common commands

```bash
npm run typecheck     # tsc --noEmit — run before declaring a task done
npm run build         # esbuild → dist/
npm run watch         # esbuild --watch (use during dev)
npm run test          # playwright test (full suite)
npx playwright test tests/2.1-detect.spec.ts   # single spec
npm run package       # build + scripts/package.mjs (zip for store)
```

## Architecture quick map

```
extension/
  background/   sw.ts (MV3 worker), llm.ts (distill + provider call), cache.ts, spend.ts
  content/      index.ts (entry), detect.ts, discover.ts, engine.ts, renderer.ts,
                schema-stub.ts (LinkedIn / fixture site rules), deep-text.ts
  panel/        panel.ts + components/ (side panel UI)
  shared/       types.ts, settings.ts, saved-filters.ts
```

Discovery flow: `detect()` → `fingerprintItemSet()` → `distill()` → SW round-trip →
LLM → cached `Schema` → `engine.evaluate()` → `Renderer.apply()`.

## Why the LLM (and when it's optional)

LLM does **two narrow jobs**: (1) schema discovery — turning a redacted DOM skeleton
into `{itemSelector, fields}`; (2) phrase suggestions in the panel. Free-text keyword
filtering works **without** the LLM via `buildLocalSchema()`. Site stubs in
`schema-stub.ts` (LinkedIn legacy + new LazyColumn, the `rolecast` fixture) bypass it
entirely. Named-field / numeric filters are the only thing that strictly requires it.

Before adding any new LLM call site, check `PRIVACY.md` and route the payload through
`distill()` — never raw DOM, never page text.

## Testing

Playwright is the only test runner. Every task in `tasks.md` ships with a
`Playwright:` line that names its done-criterion. **Do not advance on red.**

- **Quick sanity** while implementing: load the `playwright-skill` for patterns
  (selectors, waits, MV3 extension loading).
- **Formal verification** of a finished task: spawn the `test` subagent. It executes
  the task's full `Playwright:` assertion list and updates the Progress log only on
  green.
- **Live DOM probing** (LinkedIn, YouTube, etc. — sites that hydrate after
  `document_idle`): use the `mcp__plugin_playwright_playwright__browser_*` tools to
  inspect the real page. This is how the LinkedIn `/jobs/search-results/` LazyColumn
  stub was discovered (see `memory.md`).

## Skills to reach for

- `playwright-skill` — selectors, waits, MV3 extension test patterns, debugging
  flaky specs.
- `diagnose` — site rebuilds (LinkedIn rewrote `/jobs/search-results/`), MV3 SW
  termination edge cases, intermittent virtualization bugs.
- `verify` — confirm a change actually works in a real Chrome session against a real
  site, not just in the Playwright fixture.
- `run` — launch the packed extension to screenshot or interact with it.
- `tdd` — when adding a new field kind, predicate, or engine op: write the spec
  first, then the implementation.
- `prototype` — before committing to a UI change in the side panel, or before a
  speculative refactor of `detect.ts`/`engine.ts`.
- `code-review` — before opening a PR. Use `simplify` if it surfaces cleanups.
- `improve-codebase-architecture` — periodically; the three-surface split + the
  shared/types boundary deserve protection as the codebase grows.
- `handoff` — when hitting the context budget mid-task. The output goes into the
  `Handoff` block in `tasks.md`.

## Subagents

Two project-specific agents live in `.claude/agents/`:

- **`dev`** — implements **one** task at the `▶ Resume here` cursor in `tasks.md`,
  with smoke-level Playwright. Use when the user says "do the next task", "implement
  N.M", "continue building".
- **`test`** — runs the formal Playwright verification for a finished task. Use
  after `dev` reports ready, or when the user says "verify N.M" / "test the last
  task" / "run the suite".

Spawn `Explore` for read-only "where is X defined?" sweeps across the codebase.

## Conventions and gotchas (non-obvious)

- **Slice/task discipline.** `tasks.md` is the cursor. Update the Progress log on
  green; write a `Handoff` block before context exhaustion. Never end a session
  mid-task without one.
- **Context budget: 90%.** Stop and hand off when reached.
- **Privacy contract.** Only the `distill()` output may leave the user's browser.
  Adding a new attribute to its allow-list, or a new LLM call site, is a
  `PRIVACY.md`-touching change.
- **Site stubs win over heuristics** for known sites — virtualized lists break the
  repeated-structure detector. New site rule → add a stub in `schema-stub.ts`, don't
  loosen `detect()`.
- **LLM failures fall back to local detection** (`content/index.ts`). Keep that path
  alive — it's what makes the extension usable without a key.
- **MV3 SW is ephemeral.** Persist via `chrome.storage` + `chrome.alarms`. No
  in-memory globals in `background/`.
- **No comments narrating what the code does.** Comments here document *why* (a
  constraint, an incident, a subtle invariant). See the existing inline comments in
  `llm.ts` and `discover.ts` for the house style.
- **No new docs** (`*.md`, README) unless explicitly requested. Update existing ones.

## Memory and handoff

- After each completed task: append one line to the Progress log in `tasks.md`.
- New finding, gotcha, or site-shape change: add an entry to `memory.md` (most
  recent on top).
- The Anthropic auto-memory system at `~/.claude/projects/.../memory/` is for
  cross-project / cross-session facts about the user and their preferences — not a
  replacement for `tasks.md` / `memory.md`, which are the project's own log.
