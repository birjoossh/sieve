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
import { renderFilterList } from './components/filter-list.js';
import { renderHiddenList } from './components/hidden-list.js';
import { renderLlmSettings } from './components/llm-settings.js';
import {
  renderNumericFilter,
  type NumericFilterValue,
} from './components/numeric-filter.js';
import { renderPageStatus } from './components/page-status.js';
import {
  clearLlmSettings,
  loadLlmSettings,
  saveLlmSettings,
  type LlmSettings,
} from '../shared/settings.js';
import {
  clearSavedFilters,
  loadSavedFilters,
  saveFilters,
} from '../shared/saved-filters.js';
import { parseExport, serializeExport } from '../shared/filter-io.js';
import { getSpendStatus, type SpendStatus } from '../background/spend.js';
import { suggestPhrases } from '../background/llm.js';
import {
  dismissDeepWarning,
  isDeepWarningDismissed,
} from '../shared/deep-prefs.js';
import { renderDeepToggle } from './components/deep-toggle.js';
import { renderErrorPanel, type PanelError } from './components/error-panel.js';
import {
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
const NUMERIC_FIELD = 'comp';

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
  /** 4.8 phrase suggestions — in-flight + last response + last error. */
  suggesting: boolean;
  suggestions: string[];
  suggestError: string | null;
  /** Slice-3 wire-up: last discover failure (no API key, LLM error). */
  discoverError: string | null;
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
  numeric: NumericFilterValue,
): Filter[] {
  if (!schema) return [];
  const out: Filter[] = [];
  if (phrases.length > 0) {
    out.push({
      id: SLICE1_FILTER_ID,
      fingerprint: schema.fingerprint,
      polarity: 'exclude',
      field: 'snippet',
      predicate: { op: 'containsAny', phrases },
      deep: false,
      saved: false,
    });
  }
  // The numeric filter is omitted entirely when disabled — the engine
  // only sees what's currently active. (Per 4.3, multiple filters AND.)
  if (numeric.enabled && schema.fields[NUMERIC_FIELD]) {
    out.push({
      id: NUMERIC_FILTER_ID,
      fingerprint: schema.fingerprint,
      polarity: 'exclude',
      field: NUMERIC_FIELD,
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
  const filters = buildFilters(state.schema, state.phrases, state.numeric);
  try {
    await sendToContent(state.activeTabId, {
      t: 'setFilters',
      v: MESSAGE_VERSION,
      filters,
    });
  } catch (err) {
    console.error('[negative-filter] setFilters failed:', err);
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

async function pushMode(mode: DisplayMode): Promise<void> {
  state.mode = mode;
  if (state.activeTabId === null) {
    render();
    return;
  }
  try {
    await sendToContent(state.activeTabId, {
      t: 'setDisplayMode',
      v: MESSAGE_VERSION,
      mode,
    });
  } catch (err) {
    console.error('[negative-filter] setDisplayMode failed:', err);
  }
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
    console.error('[negative-filter] setItemRestored failed:', err);
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
    console.error('[negative-filter] enableDomain failed:', reply.message);
    return;
  }
  void refresh();
}

async function handleDisable(origin: string): Promise<void> {
  const reply = await sendToSw({ t: 'disableDomain', v: MESSAGE_VERSION, origin });
  if (reply.t === 'err') {
    console.error('[negative-filter] disableDomain failed:', reply.message);
    return;
  }
  await chrome.permissions
    .remove({ origins: [originMatchPattern(origin)] })
    .catch(() => undefined);
  void refresh();
}

// --- Top-level reconcile + render -----------------------------------------

async function refresh(): Promise<void> {
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
        state.phrases =
          phraseFilter && phraseFilter.predicate.op === 'containsAny'
            ? [...phraseFilter.predicate.phrases]
            : [];
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

async function handleSuggest(): Promise<void> {
  if (state.suggesting) return;
  if (!state.llmSettings || state.llmSettings.apiKey.trim() === '') {
    state.suggestError = 'Add a provider key in LLM settings to fetch suggestions.';
    render();
    return;
  }
  state.suggesting = true;
  state.suggestError = null;
  render();
  try {
    // Test seam: spec injects window.__nfFetcher so the suggestion
    // call doesn't reach the real provider. In production the
    // injection is absent and globalThis.fetch is used.
    const fetcher = (globalThis as unknown as { __nfFetcher?: typeof fetch }).__nfFetcher;
    const next = await suggestPhrases({
      provider: state.llmSettings.provider,
      apiKey: state.llmSettings.apiKey,
      existing: state.phrases,
      intent: 'phrases to add to a negative filter on this page',
      ...(state.llmSettings.model !== undefined ? { model: state.llmSettings.model } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
    state.suggestions = next;
  } catch (err) {
    state.suggestError = err instanceof Error ? err.message : String(err);
  } finally {
    state.suggesting = false;
    render();
  }
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
    console.error('[negative-filter] dismissDeepWarning failed:', err);
  }
  state.deepWarningDismissed = true;
  state.deepModalOpen = false;
  render();
}

async function handleSaveFilters(): Promise<void> {
  if (!state.schema) return;
  const filters = buildFilters(state.schema, state.phrases, state.numeric);
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
  a.download = `negative-filter-export-${Date.now()}.json`;
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
    console.error('[negative-filter] import failed:', err);
    return;
  }
  for (const [fp, set] of Object.entries(env.sets)) {
    await saveFilters(fp, set);
  }
  // Refresh in case the active fingerprint was imported.
  void refresh();
}

async function handleClearSavedFilters(): Promise<void> {
  if (!state.schema) return;
  await clearSavedFilters(state.schema.fingerprint);
  state.savedExists = false;
  render();
}

async function handleSaveLlmSettings(next: LlmSettings): Promise<void> {
  await saveLlmSettings(next);
  state.llmSettings = next;
  render();
}

async function handleClearLlmSettings(): Promise<void> {
  await clearLlmSettings();
  state.llmSettings = null;
  render();
}

function render(): void {
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
      mode: state.mode,
      onModeChange: (m) => void pushMode(m),
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
            console.error('[negative-filter] rediscover failed:', err);
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
  const errorHost = document.getElementById('error-panel');
  if (errorHost) renderErrorPanel(errorHost, { errors });

  const numericHost = document.getElementById('numeric-filter');
  if (numericHost) {
    renderNumericFilter(numericHost, {
      enabled:
        state.enabled &&
        state.schema !== null &&
        state.schema.fields[NUMERIC_FIELD] !== undefined,
      current: state.numeric,
      unit: 'k$',
      min: 0,
      max: 300,
      step: 10,
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

chrome.runtime.onMessage.addListener((raw: unknown, _sender, _sendResponse) => {
  if (!isContentToPanel(raw)) return false;
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
    case 'discoverError':
      state.discoverError = raw.message;
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
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url !== undefined) {
    void refresh();
  }
});
