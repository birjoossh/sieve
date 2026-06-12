// panel/panel.ts — side-panel orchestrator.
//
// The panel is a thin renderer over content-script truth: it asks the
// content script for the current state on open (and after the active tab
// changes), and listens for itemStates pushes so HIDDEN (N) stays live as
// the user clicks slivers in the page.
//
// Slice 1 wiring:
//   - settings.ts (carry-over from 0.4/0.6): enable / disable per origin
//   - page-status.ts (1.8): COLLAPSE | HIDE display-mode toggle
//   - filter-list.ts (1.6): one filter; chips edit its phrase list
//   - hidden-list.ts (1.7): per-row + bulk restore ⇄ hide
//
// User actions dispatch a PanelToContent message; the response (state) or
// the push that follows refreshes panel-local mirrors. Filters live
// canonically in the panel for the session — refresh() reconciles to
// content state on tab switch so closing/reopening the panel preserves
// what content already knows.

import { renderEnableButton } from './components/settings.js';
import { renderFilterList, type PhrasePolarity } from './components/filter-list.js';
import { renderHiddenList } from './components/hidden-list.js';
import { renderLlmSettings } from './components/llm-settings.js';
import {
  renderNumericFilter,
  type NumericFilterValue,
} from './components/numeric-filter.js';
import { renderPageStatus } from './components/page-status.js';
import {
  baseUrlIssue,
  clearLlmSettings,
  loadLlmSettings,
  saveLlmSettings,
  type LlmSettings,
} from '../shared/settings.js';
import {
  clearSavedFilters,
  isFilterShape,
  loadSavedFilters,
  saveFilters,
} from '../shared/saved-filters.js';
import {
  parseExport,
  serializeExport,
  type FilterImportResult,
} from '../shared/filter-io.js';
import { getSpendStatus, type SpendStatus } from '../background/spend.js';
import {
  dismissDeepWarning,
  isDeepWarningDismissed,
} from '../shared/deep-prefs.js';
import { renderDeepToggle } from './components/deep-toggle.js';
import { renderErrorPanel, type PanelError } from './components/error-panel.js';
import {
  ALL_TEXT_FIELD,
  isContentToPanel,
  MESSAGE_VERSION,
  originMatchPattern,
  scriptIdFor,
  sendToContent,
  sendToSw,
  type DisplayMode,
  type Filter,
  type ItemSummary,
  type Schema,
} from '../shared/types.js';

// --- The single Slice-1 filter --------------------------------------------
// We expose one user-controlled filter — snippet, containsAny — to keep
// the Slice-1 UX surface narrow. The id is stable for the session so
// content-side dedup works (replacing on every push).

const SLICE1_FILTER_ID = 'panel-phrase-filter';
const NUMERIC_FILTER_ID = 'panel-numeric-filter';

/** First number-kind field on the schema — the numeric editor binds to it.
 *  Was hardcoded to `comp` (the rolecast stub's only number field), which
 *  left the numeric filter dark on every real marketplace page whose
 *  LLM-discovered or locally-detected field is `price` (bugs.md #2). */
function numericFieldOf(schema: Schema | null): string | null {
  if (!schema) return null;
  for (const [name, spec] of Object.entries(schema.fields)) {
    if (spec.kind === 'number') return name;
  }
  return null;
}

const NUMERIC_DEFAULT: NumericFilterValue = {
  enabled: false,
  op: 'lessThan',
  value: 100,
};

interface PanelState {
  activeTabId: number | null;
  origin: string | null;
  enabled: boolean;
  schema: Schema | null;
  phrases: string[];
  /** Phrase-filter polarity. `off` is session-only: chips stay in the
   *  panel but no phrase filter is pushed to content. */
  polarity: PhrasePolarity;
  numeric: NumericFilterValue;
  mode: DisplayMode;
  items: ItemSummary[];
  llmSettings: LlmSettings | null;
  /** 4.5: does storage.sync hold a saved filter set for the current
   *  fingerprint? Drives the Clear-saved button visibility + the
   *  "saved" badge. */
  savedExists: boolean;
  /** 4.7 spend cap surface — snapshot of the LLM-call ledger. Null
   *  until the first refresh() resolves it. */
  spend: SpendStatus | null;
  /** Phrase suggestions (4.8, made local in 4.15) — in-flight + last
   *  response + last error. Sourced from the content script's detected
   *  items, never the network. */
  suggesting: boolean;
  suggestions: string[];
  suggestError: string | null;
  /** Slice-3 wire-up: last discover failure (no API key, LLM error). */
  discoverError: string | null;
  /** A filter the engine refused to run (unsafe/invalid regex). Cleared on
   *  the next filter push; re-set by content if the filter is still bad. */
  filterError: string | null;
  /** Last import's soft failures (malformed rows dropped, sync-quota write
   *  errors). Null after a clean import. */
  importError: string | null;
  /** 5.6 deep-scan toggle + first-use modal. */
  deepOn: boolean;
  deepWarningDismissed: boolean;
  deepModalOpen: boolean;
}

const state: PanelState = {
  activeTabId: null,
  origin: null,
  enabled: false,
  schema: null,
  phrases: [],
  polarity: 'exclude',
  numeric: { ...NUMERIC_DEFAULT },
  mode: 'collapse',
  items: [],
  llmSettings: null,
  savedExists: false,
  spend: null,
  suggesting: false,
  suggestions: [],
  suggestError: null,
  discoverError: null,
  filterError: null,
  importError: null,
  deepOn: false,
  deepWarningDismissed: false,
  deepModalOpen: false,
};

const ENABLEABLE_PROTOCOLS = new Set(['http:', 'https:']);

function originOf(tab: chrome.tabs.Tab | undefined): string | null {
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    if (!ENABLEABLE_PROTOCOLS.has(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function activeContentTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

async function isOriginEnabled(origin: string): Promise<boolean> {
  const id = scriptIdFor(origin);
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  return scripts.length > 0;
}

// --- Build the Slice-1 filter from the current phrase list ----------------

function buildFilters(
  schema: Schema | null,
  phrases: string[],
  polarity: PhrasePolarity,
  numeric: NumericFilterValue,
): Filter[] {
  if (!schema) return [];
  const out: Filter[] = [];
  // `off` omits the phrase filter entirely — the chips stay panel-side so
  // the user's curated list survives the pause.
  if (phrases.length > 0 && polarity !== 'off') {
    out.push({
      id: SLICE1_FILTER_ID,
      fingerprint: schema.fingerprint,
      polarity,
      field: ALL_TEXT_FIELD,
      predicate: { op: 'containsAny', phrases },
      deep: false,
      saved: false,
    });
  }
  // The numeric filter is omitted entirely when disabled — the engine
  // only sees what's currently active. (Per 4.3, multiple filters AND.)
  const numericField = numericFieldOf(schema);
  if (numeric.enabled && numericField !== null) {
    out.push({
      id: NUMERIC_FILTER_ID,
      fingerprint: schema.fingerprint,
      polarity: 'exclude',
      field: numericField,
      predicate:
        numeric.op === 'lessThan'
          ? { op: 'lessThan', value: numeric.value }
          : { op: 'greaterThan', value: numeric.value },
      deep: false,
      saved: false,
    });
  }
  return out;
}

async function pushFilters(): Promise<void> {
  if (state.activeTabId === null) return;
  // A fresh push supersedes the last per-filter rejection; content re-emits
  // filterError during its recompute if a filter is still bad.
  state.filterError = null;
  const filters = buildFilters(state.schema, state.phrases, state.polarity, state.numeric);
  try {
    await sendToContent(state.activeTabId, {
      t: 'setFilters',
      v: MESSAGE_VERSION,
      filters,
    });
  } catch (err) {
    console.error('[sieve] setFilters failed:', err);
  }
}

// --- Dispatchers to content ------------------------------------------------

async function pushPhrases(phrases: string[]): Promise<void> {
  state.phrases = phrases;
  await pushFilters();
  render();
}

async function pushNumeric(next: NumericFilterValue): Promise<void> {
  state.numeric = next;
  await pushFilters();
  render();
}

async function pushPolarity(next: PhrasePolarity): Promise<void> {
  state.polarity = next;
  await pushFilters();
  render();
}

async function pushItemRestored(id: string, restored: boolean): Promise<void> {
  if (state.activeTabId === null) return;
  try {
    await sendToContent(state.activeTabId, {
      t: 'setItemRestored',
      v: MESSAGE_VERSION,
      itemId: id,
      restored,
    });
  } catch (err) {
    console.error('[sieve] setItemRestored failed:', err);
  }
}

async function pushAllRestored(restored: boolean): Promise<void> {
  const targets = state.items
    .filter((i) => (restored ? i.state === 'filtered' : i.state === 'restored'))
    .map((i) => i.id);
  // Fire all in parallel — content handles them independently.
  await Promise.all(targets.map((id) => pushItemRestored(id, restored)));
}

// --- Enable / disable (carry-over from 0.6) -------------------------------

async function handleEnable(origin: string): Promise<void> {
  const granted = await chrome.permissions.request({
    origins: [originMatchPattern(origin)],
  });
  if (!granted) return;
  const reply = await sendToSw({ t: 'enableDomain', v: MESSAGE_VERSION, origin });
  if (reply.t === 'err') {
    console.error('[sieve] enableDomain failed:', reply.message);
    return;
  }
  // registerContentScripts only injects on NEXT page load, so without this
  // the user has to reload the tab before anything happens — and worse, after
  // a `chrome://extensions` reload (which silently drops dynamic registrations
  // but preserves the host permission), re-toggling Enable wouldn't recover
  // the active tab either. executeScript against the active tab covers both
  // cases. Failures are non-fatal: the page may be chrome:// or a privileged
  // origin that scripting can't touch — the user can still see filtering on
  // the next normal navigation.
  try {
    const tab = await activeContentTab();
    if (tab?.id !== undefined && tab.url && new URL(tab.url).origin === origin) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content.js'],
      });
    }
  } catch (err) {
    console.warn('[negative-filter] active-tab inject skipped:', err);
  }
  void refresh();
}

async function handleDisable(origin: string): Promise<void> {
  const reply = await sendToSw({ t: 'disableDomain', v: MESSAGE_VERSION, origin });
  if (reply.t === 'err') {
    console.error('[sieve] disableDomain failed:', reply.message);
    return;
  }
  await chrome.permissions
    .remove({ origins: [originMatchPattern(origin)] })
    .catch(() => undefined);
  void refresh();
}

// --- Top-level reconcile + render -----------------------------------------

async function refresh(): Promise<void> {
  // Capture session-side filter state before we read content's view of the
  // world. If content re-initialized (full page navigation on the active
  // tab) it'll report an empty filter list — without this snapshot the
  // assignments below would clobber the panel's chips and the user's
  // unsaved phrases would silently vanish.
  const prevOrigin = state.origin;
  const prevPhrases = state.phrases;
  const prevNumeric = state.numeric;

  const tab = await activeContentTab();
  state.activeTabId = tab?.id ?? null;
  state.origin = originOf(tab);
  state.enabled = state.origin === null ? false : await isOriginEnabled(state.origin);
  state.llmSettings = await loadLlmSettings();

  if (state.activeTabId !== null && state.enabled) {
    try {
      const reply = await sendToContent(state.activeTabId, {
        t: 'getState',
        v: MESSAGE_VERSION,
      });
      if (reply.t === 'state') {
        state.schema = reply.state.schema;
        state.mode = reply.state.mode;
        state.items = reply.state.items;
        // Reconcile phrases from content's filter list.
        const phraseFilter = reply.state.filters.find(
          (f) => f.id === SLICE1_FILTER_ID && f.predicate.op === 'containsAny',
        );
        if (phraseFilter && phraseFilter.predicate.op === 'containsAny') {
          state.phrases = [...phraseFilter.predicate.phrases];
          state.polarity = phraseFilter.polarity === 'keep' ? 'keep' : 'exclude';
        } else if (!(state.polarity === 'off' && prevOrigin === state.origin)) {
          // No phrase filter content-side. When the panel is in `off`,
          // that's deliberate — keep the chips (session state) instead of
          // mirroring the empty list. Otherwise clear as before. Polarity
          // itself is never reset here: a pre-phrases "Show only matches"
          // choice must survive the refresh storm from tab events.
          state.phrases = [];
        }
        // Reconcile numeric filter from content's filter list. Falls
        // back to the panel default when content has no numeric filter
        // yet (a freshly enabled tab).
        const numericFilter = reply.state.filters.find((f) => f.id === NUMERIC_FILTER_ID);
        if (
          numericFilter &&
          (numericFilter.predicate.op === 'lessThan' ||
            numericFilter.predicate.op === 'greaterThan')
        ) {
          state.numeric = {
            enabled: true,
            op: numericFilter.predicate.op,
            value: numericFilter.predicate.value,
          };
        } else {
          state.numeric = { ...NUMERIC_DEFAULT };
        }

        // Session-state preservation across content re-init. When the
        // active tab navigated (LinkedIn "new search" hits a fresh
        // /jobs/search-results/?keywords=…), the content script re-
        // injects with an empty filter set. We had the user's typed
        // phrases in the panel — re-push them so filtering persists
        // without forcing the user to retype. Scoped to same origin so
        // a real tab switch still discards stale state. The content
        // monkey-patched SPA watcher can't intercept page-realm
        // pushState (isolated worlds), so this panel-side reconcile is
        // the only path that's reliably reachable on real SPAs.
        const sameOrigin = prevOrigin !== null && prevOrigin === state.origin;
        const contentLostFilters =
          state.phrases.length === 0 && prevPhrases.length > 0;
        const contentLostNumeric = !state.numeric.enabled && prevNumeric.enabled;
        if (state.schema && sameOrigin && (contentLostFilters || contentLostNumeric)) {
          if (contentLostFilters) state.phrases = prevPhrases;
          if (contentLostNumeric) state.numeric = prevNumeric;
          void pushFilters();
        }
      } else if (reply.t === 'err') {
        state.schema = null;
        state.items = [];
      }
    } catch {
      // Content script not running yet (just enabled, no reload yet) —
      // surface that as "no schema."
      state.schema = null;
      state.items = [];
    }
  } else {
    state.schema = null;
    state.items = [];
    state.phrases = [];
  }

  // 5.6: load the deep-warning-dismissed flag once per refresh so the
  // modal-open state stays in sync if the user enables/dismisses on
  // another device or window.
  try {
    state.deepWarningDismissed = await isDeepWarningDismissed();
  } catch {
    state.deepWarningDismissed = false;
  }

  // 4.7: snapshot the spend ledger so the LLM settings section can
  // display usage + cap-reached warnings. Doesn't depend on the
  // active tab — global to the user.
  try {
    state.spend = await getSpendStatus();
  } catch {
    state.spend = null;
  }

  // 4.5: probe storage.sync so the Save / Clear-saved buttons reflect
  // the persisted state. Always check, never block — surface a false
  // on error so the user can still hit Save.
  if (state.schema) {
    try {
      const saved = await loadSavedFilters(state.schema.fingerprint);
      state.savedExists = saved.length > 0;
    } catch {
      state.savedExists = false;
    }
  } else {
    state.savedExists = false;
  }

  render();
}

/** Suggestions shown to the user at once. */
const SUGGEST_DISPLAY_MAX = 8;
/** Wider candidate pull for LLM curation — the provider picks the best 8. */
const SUGGEST_LLM_CANDIDATES = 24;

async function handleSuggest(): Promise<void> {
  if (state.suggesting) return;
  // Candidates are extracted locally from the detected items by the content
  // script (content/suggest.ts) — top recurring tokens, no network. With an
  // LLM key configured we additionally send THOSE CANDIDATES (never raw page
  // text — PRIVACY.md) to the provider for curation; any failure falls back
  // to the local list so the button always works.
  if (state.activeTabId === null || state.schema === null) {
    state.suggestError = 'Suggestions need a detected list on this page.';
    render();
    return;
  }
  const hasKey = state.llmSettings !== null && state.llmSettings.apiKey.trim() !== '';
  state.suggesting = true;
  state.suggestError = null;
  render();
  try {
    const reply = await sendToContent(state.activeTabId, {
      t: 'getSuggestions',
      v: MESSAGE_VERSION,
      max: hasKey ? SUGGEST_LLM_CANDIDATES : SUGGEST_DISPLAY_MAX,
    });
    if (reply.t === 'suggestions') {
      let phrases = reply.phrases;
      if (hasKey && phrases.length > 0) {
        try {
          const curated = await sendToSw({
            t: 'suggestPhrases',
            v: MESSAGE_VERSION,
            existing: state.phrases,
            candidates: phrases,
          });
          if (curated.t === 'suggestions' && curated.phrases.length > 0) {
            phrases = curated.phrases;
          } else if (curated.t === 'err') {
            console.warn('[sieve] LLM suggestion curation failed:', curated.message);
          }
        } catch (err) {
          console.warn('[sieve] LLM suggestion curation failed:', err);
        }
      }
      state.suggestions = phrases.slice(0, SUGGEST_DISPLAY_MAX);
    } else if (reply.t === 'err') {
      state.suggestError = 'Suggestions need a detected list on this page.';
    }
  } catch (err) {
    state.suggestError = err instanceof Error ? err.message : String(err);
  } finally {
    state.suggesting = false;
    render();
  }
}

/** Turn a bare "Failed to fetch" into an actionable hint that names the
 *  host permission the user almost certainly needs to grant. Leaves other
 *  errors untouched. */
function decorateFetchError(message: string, pattern: string | null): string {
  if (!/failed to fetch/i.test(message)) return message;
  if (pattern === null) return message;
  return `${message} — likely missing host permission for ${pattern}. Click Save in LLM settings and accept the prompt.`;
}

function handleAcceptSuggestion(phrase: string): void {
  if (state.phrases.includes(phrase)) {
    state.suggestions = state.suggestions.filter((s) => s !== phrase);
    render();
    return;
  }
  state.suggestions = state.suggestions.filter((s) => s !== phrase);
  void pushPhrases([...state.phrases, phrase]);
}

function handleDismissSuggestions(): void {
  state.suggestions = [];
  state.suggestError = null;
  render();
}

function handleToggleDeep(next: boolean): void {
  state.deepOn = next;
  // Show the modal the first time deep gets enabled, unless the
  // user already dismissed it on a previous occasion.
  if (next && !state.deepWarningDismissed) {
    state.deepModalOpen = true;
  }
  render();
}

async function handleDismissDeepWarning(): Promise<void> {
  try {
    await dismissDeepWarning();
  } catch (err) {
    console.error('[sieve] dismissDeepWarning failed:', err);
  }
  state.deepWarningDismissed = true;
  state.deepModalOpen = false;
  render();
}

async function handleSaveFilters(): Promise<void> {
  if (!state.schema) return;
  const filters = buildFilters(state.schema, state.phrases, state.polarity, state.numeric);
  await saveFilters(state.schema.fingerprint, filters);
  state.savedExists = true;
  render();
}

async function handleExportFilters(): Promise<void> {
  // Read every saved set across all fingerprints. The whole
  // storage.sync read is cheap (small payload); a per-fp read loop
  // would need a fingerprint inventory we don't currently maintain.
  const all = await chrome.storage.sync.get(null);
  const sets: Record<string, Filter[]> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('nf:filters:')) continue;
    if (!Array.isArray(v)) continue;
    sets[k.replace(/^nf:filters:/, '')] = v as Filter[];
  }
  const json = serializeExport(sets, Date.now());
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sieve-export-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the download has time to read the blob (some
  // browsers grab synchronously, others not).
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function handleImportFilters(file: File): Promise<void> {
  let env;
  try {
    const text = await file.text();
    env = parseExport(text);
  } catch (err) {
    state.importError = err instanceof Error ? err.message : String(err);
    render();
    return;
  }
  // parseExport only checks the envelope; each filter row still needs the
  // same shape validation the boot read runs — saveFilters() writes blind.
  // storage.sync rejections (8 KB/item, 100 KB total quota) surface per set
  // instead of silently truncating the import.
  const result: FilterImportResult = { setsImported: 0, filtersImported: 0, warnings: [] };
  for (const [fp, set] of Object.entries(env.sets)) {
    const valid = set.filter(isFilterShape);
    if (valid.length < set.length) {
      result.warnings.push(`${fp}: dropped ${set.length - valid.length} malformed filter(s)`);
    }
    if (valid.length === 0) continue;
    try {
      await saveFilters(fp, valid);
      result.setsImported += 1;
      result.filtersImported += valid.length;
    } catch (err) {
      result.warnings.push(
        `${fp}: save failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  state.importError = result.warnings.length > 0 ? result.warnings.join('; ') : null;
  console.log(
    `[sieve] import: ${result.filtersImported} filter(s) across ${result.setsImported} set(s)` +
      (result.warnings.length > 0 ? `; ${result.warnings.length} warning(s)` : ''),
  );
  // Refresh in case the active fingerprint was imported.
  void refresh();
}

async function handleClearSavedFilters(): Promise<void> {
  if (!state.schema) return;
  await clearSavedFilters(state.schema.fingerprint);
  state.savedExists = false;
  render();
}

/** Default provider endpoints, mirrored from background/llm.ts. Used to
 *  derive the host we must hold permission for when no custom base URL is
 *  set. Keep in sync with DEFAULT base there. */
const PROVIDER_DEFAULT_BASE: Record<LlmSettings['provider'], string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** `https://host/*` match pattern for the endpoint these settings will call,
 *  or null if the URL can't be parsed. The service worker's outbound fetch
 *  is blocked by MV3 unless this origin is in granted host_permissions —
 *  the "Failed to fetch" symptom when only the page origin was granted. */
function endpointOriginPattern(s: LlmSettings): string | null {
  const raw = s.baseUrl && s.baseUrl.trim() !== '' ? s.baseUrl : PROVIDER_DEFAULT_BASE[s.provider];
  try {
    return `${new URL(raw).origin}/*`;
  } catch {
    return null;
  }
}

async function handleSaveLlmSettings(next: LlmSettings): Promise<void> {
  // Refuse to persist an insecure proxy URL: the provider call ships the
  // API key in two headers, so an http:// base would broadcast it in
  // cleartext. llm.ts re-checks at call time; this is the user-facing gate.
  if (next.baseUrl !== undefined && next.baseUrl.trim() !== '') {
    const issue = baseUrlIssue(next.baseUrl.trim());
    if (issue !== null) {
      state.discoverError = `LLM settings not saved: ${issue}.`;
      render();
      return;
    }
  }
  // Request host permission for the provider endpoint FIRST, while the Save
  // click's user gesture is still active (chrome.permissions.request requires
  // one). Without this grant the SW fetch to e.g. openrouter.ai fails with
  // "Failed to fetch". If the user declines we still save the key but surface
  // a clear warning so the next failed call doesn't read as a generic network
  // error.
  const pattern = endpointOriginPattern(next);
  let permissionGranted: boolean | null = null;
  if (pattern !== null) {
    try {
      permissionGranted = await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
      console.error('[negative-filter] LLM host permission request failed:', err);
    }
  }
  await saveLlmSettings(next);
  state.llmSettings = next;
  if (permissionGranted === false && pattern !== null) {
    state.discoverError =
      `Permission for ${pattern} was not granted — LLM calls will fail with "Failed to fetch". ` +
      `Click Save again and accept the Chrome permission prompt.`;
  } else {
    state.discoverError = null;
    state.suggestError = null;
  }
  render();
}

async function handleClearLlmSettings(): Promise<void> {
  await clearLlmSettings();
  state.llmSettings = null;
  render();
}

/** "comp" → "Comp", "salary_range" → "Salary Range". Schema field names are
 *  machine ids; the UI always shows the humanized form. */
function humanizeFieldName(field: string): string {
  return field
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function render(): void {
  // Pre-enable, the panel is a single first-run card — the per-page
  // sections only appear once filtering is active on the tab's origin.
  const active = state.origin !== null && state.enabled;
  for (const id of ['page-status', 'filter-list', 'numeric-filter', 'deep-toggle', 'hidden-list']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !active;
  }

  const settingsHost = document.getElementById('settings');
  if (settingsHost) {
    renderEnableButton(settingsHost, {
      origin: state.origin,
      enabled: state.enabled,
      onEnable: handleEnable,
      onDisable: handleDisable,
    });
  }

  const llmHost = document.getElementById('llm-settings');
  if (llmHost) {
    renderLlmSettings(llmHost, {
      current: state.llmSettings,
      onSave: (next) => void handleSaveLlmSettings(next),
      onClear: () => void handleClearLlmSettings(),
      ...(state.spend ? { spend: state.spend } : {}),
    });
  }

  const pageHost = document.getElementById('page-status');
  if (pageHost) {
    renderPageStatus(pageHost, {
      schema: state.schema,
      itemCount: state.items.length,
      // Slice 3.5 + production wire-up: send rediscover to content,
      // which runs detect/distill/fetchSchema via SW and emits the
      // resulting pageDetected (or discoverError) push.
      onRediscover: (payload) => {
        void (async () => {
          if (state.activeTabId === null) return;
          try {
            await sendToContent(state.activeTabId, {
              t: 'rediscover',
              v: MESSAGE_VERSION,
              ...(payload.hint !== undefined ? { hint: payload.hint } : {}),
              force: payload.force,
            });
          } catch (err) {
            console.error('[sieve] rediscover failed:', err);
          }
        })();
      },
    });
  }

  const filterHost = document.getElementById('filter-list');
  if (filterHost) {
    renderFilterList(filterHost, {
      enabled: state.enabled && state.schema !== null,
      phrases: state.phrases,
      polarity: state.polarity,
      onPolarityChange: (p) => void pushPolarity(p),
      onChange: (p) => void pushPhrases(p),
      onSave: () => void handleSaveFilters(),
      onClearSaved: () => void handleClearSavedFilters(),
      savedExists: state.savedExists,
      onExport: () => void handleExportFilters(),
      onImport: (f) => void handleImportFilters(f),
      onSuggest: () => void handleSuggest(),
      suggestions: state.suggestions,
      suggesting: state.suggesting,
      ...(state.suggestError ? { suggestError: state.suggestError } : {}),
      onAcceptSuggestion: handleAcceptSuggestion,
      onDismissSuggestions: handleDismissSuggestions,
    });
  }

  // 6.4: derive error rows from current state. Missing schema +
  // spend-cap + last LLM error all surface as user-facing rows the
  // panel will render in the error-panel section.
  const errors: PanelError[] = [];
  if (state.enabled && state.schema === null) {
    errors.push({
      kind: 'missing-schema',
      message: "We didn't detect a list on this page yet.",
    });
  }
  if (state.spend?.capReached) {
    errors.push({
      kind: 'spend-cap',
      message:
        state.spend.cappedPeriod === 'day'
          ? `${state.spend.dailyUsed}/${state.spend.dailyCap} calls used today.`
          : `${state.spend.monthlyUsed}/${state.spend.monthlyCap} calls used this month.`,
    });
  }
  if (state.suggestError) {
    errors.push({ kind: 'llm-error', message: state.suggestError });
  }
  if (state.discoverError) {
    errors.push({ kind: 'llm-error', message: state.discoverError });
  }
  if (state.filterError) {
    errors.push({ kind: 'unsafe-regex', message: state.filterError });
  }
  if (state.importError) {
    errors.push({ kind: 'import-error', message: state.importError });
  }
  const errorHost = document.getElementById('error-panel');
  if (errorHost) renderErrorPanel(errorHost, { errors });

  const numericHost = document.getElementById('numeric-filter');
  if (numericHost) {
    const numericField = numericFieldOf(state.schema);
    renderNumericFilter(numericHost, {
      enabled: state.enabled && numericField !== null,
      current: state.numeric,
      label: humanizeFieldName(numericField ?? 'value'),
      onChange: (next) => void pushNumeric(next),
    });
  }

  const deepHost = document.getElementById('deep-toggle');
  if (deepHost) {
    renderDeepToggle(deepHost, {
      enabled: state.enabled && state.schema !== null,
      deepOn: state.deepOn,
      warningDismissed: state.deepWarningDismissed,
      modalOpen: state.deepModalOpen,
      onToggleDeep: handleToggleDeep,
      onDismissWarning: () => void handleDismissDeepWarning(),
    });
  }

  const hiddenHost = document.getElementById('hidden-list');
  if (hiddenHost) {
    renderHiddenList(hiddenHost, {
      items: state.items,
      onSetItem: (id, restored) => void pushItemRestored(id, restored),
      onSetAll: (restored) => void pushAllRestored(restored),
    });
  }
}

// --- Content → panel pushes ------------------------------------------------

chrome.runtime.onMessage.addListener((raw: unknown, sender, _sendResponse) => {
  if (!isContentToPanel(raw)) return false;
  // With the extension enabled on two tabs, both content scripts push here.
  // Only the active tab may drive the panel — a background tab's itemStates
  // would overwrite the HIDDEN list and item counts for the tab the user is
  // actually looking at (same per-tab discipline as the SW's badge handler).
  const senderTabId = sender.tab?.id;
  if (senderTabId !== undefined && senderTabId !== state.activeTabId) return false;
  switch (raw.t) {
    case 'itemStates':
      state.items = raw.items;
      render();
      break;
    case 'pageDetected':
      // The schema may have just landed — re-pull state. Clear any
      // previous discover error since a successful detect supersedes it.
      state.discoverError = null;
      void refresh();
      break;
    case 'discoverError': {
      const pattern = state.llmSettings ? endpointOriginPattern(state.llmSettings) : null;
      state.discoverError = decorateFetchError(raw.message, pattern);
      render();
      break;
    }
    case 'filterError':
      state.filterError = `Filter "${raw.filterId}" was skipped: ${raw.message}`;
      render();
      break;
  }
  return false;
});

// --- Boot + tab tracking ---------------------------------------------------

void refresh();

chrome.tabs.onActivated.addListener(() => {
  void refresh();
});
chrome.tabs.onUpdated.addListener((id, info) => {
  // Every tab in every window fires here; a full refresh() is a content
  // round-trip + four storage reads, so only the active tab earns one.
  if (id !== state.activeTabId) return;
  if (info.status === 'complete' || info.url !== undefined) {
    void refresh();
  }
});
