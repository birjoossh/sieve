# Memory — Negative Filter

Lessons learned during the build. Most recent on top. Per project CLAUDE.md: any
finding worth saving the next session a re-derivation goes here.

---

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
into the panel's console. The 0.5 spec's "no [negative-filter]
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
