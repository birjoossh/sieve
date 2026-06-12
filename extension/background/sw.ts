// background/sw.ts — service worker entry.
//
// MV3 reality: this worker can be terminated any time. Anything that must
// persist goes through chrome.storage + chrome.alarms, never in-memory globals.
// chrome.scripting.registerContentScripts is itself persistent across SW
// restarts (Chrome stores the registration table), so the enableDomain path
// is durable without our own bookkeeping.

import {
  isContentToPanel,
  isPanelMsg,
  MESSAGE_VERSION,
  originMatchPattern,
  scriptIdFor,
  type PanelMsg,
  type SwToPanel,
} from '../shared/types.js';
import { chromeStorageSchemaCache, getOrDiscover } from './cache.js';
import { suggestPhrases } from './llm.js';
import { loadLlmSettings } from '../shared/settings.js';
import { chromeStorageSpendChecker } from './spend.js';

const CONTENT_SCRIPT_FILE = 'content.js';

// Without this, clicking the toolbar button does nothing at all — the side
// panel only opens via the puzzle-piece menu, which reads as a dead install.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => undefined);

void chrome.action.setBadgeBackgroundColor({ color: '#059669' }).catch(() => undefined);

// SPA route changes (history.pushState in the page realm) never reach the
// content script's own history patch — MV3 isolated worlds don't share the
// History object (memory.md 2026-06-06; bit us live on LinkedIn search).
// tabs.onUpdated DOES fire with changeInfo.url for pushState, so relay it.
// Tabs without our content script reject the message — swallowed.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  void chrome.tabs
    .sendMessage(tabId, { t: 'spaNavigated', v: MESSAGE_VERSION, url: changeInfo.url })
    .catch(() => undefined);
});

async function registerForOrigin(origin: string): Promise<void> {
  const id = scriptIdFor(origin);
  // Idempotency: chrome throws "Duplicate script ID" if the same id is
  // already registered. Re-enabling a domain (e.g. after a panel reload)
  // shouldn't error.
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [originMatchPattern(origin)],
      js: [CONTENT_SCRIPT_FILE],
      runAt: 'document_idle',
      world: 'ISOLATED',
    },
  ]);
}

async function unregisterForOrigin(origin: string): Promise<void> {
  const id = scriptIdFor(origin);
  // Same idempotency concern in reverse — unregistering an id that isn't
  // there throws, which would mask the real "actually unregister"
  // expectation on a fresh disable.
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length === 0) return;

  await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

async function handle(msg: PanelMsg): Promise<SwToPanel> {
  switch (msg.t) {
    case 'ping':
      return { t: 'pong', v: MESSAGE_VERSION };
    case 'enableDomain':
      await registerForOrigin(msg.origin);
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'disableDomain':
      await unregisterForOrigin(msg.origin);
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'discoverSchema': {
      // Production wire-up of Slice 3.x's deferred capstone: content
      // ships us a distilled DOM + fingerprint, we route through the
      // cache + LLM and return the Schema (or err with a reason the
      // panel's error-panel can surface).
      const settings = await loadLlmSettings();
      if (!settings || settings.apiKey.trim() === '') {
        return {
          t: 'err',
          v: MESSAGE_VERSION,
          message: 'no-api-key: add a provider key in the panel under "LLM provider".',
        };
      }
      const req: Parameters<typeof getOrDiscover>[0] = {
        fingerprint: msg.fingerprint,
        distilled: msg.distilled,
      };
      if (msg.hint !== undefined) req.hint = msg.hint;
      if (msg.force) req.force = true;
      try {
        const schema = await getOrDiscover(req, {
          cache: chromeStorageSchemaCache(),
          // Enforced inside discoverSchema: canSpend BEFORE the provider
          // fetch (blocked call costs zero network), recordSpend only after
          // a validated schema. Cache hits never touch the meter.
          spend: chromeStorageSpendChecker(),
          loadSettings: async () => {
            const s: {
              provider: typeof settings.provider;
              apiKey: string;
              model?: string;
              baseUrl?: string;
            } = {
              provider: settings.provider,
              apiKey: settings.apiKey,
            };
            if (settings.model !== undefined) s.model = settings.model;
            if (settings.baseUrl !== undefined) s.baseUrl = settings.baseUrl;
            return s;
          },
        });
        return { t: 'schema', v: MESSAGE_VERSION, schema };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { t: 'err', v: MESSAGE_VERSION, message };
      }
    }
    case 'suggestPhrases': {
      // LLM curation of the locally-extracted candidates (bugs.md #1
      // feedback). Same key + spend-cap contract as discoverSchema; the
      // panel falls back to the raw local candidates on any err.
      const settings = await loadLlmSettings();
      if (!settings || settings.apiKey.trim() === '') {
        return {
          t: 'err',
          v: MESSAGE_VERSION,
          message: 'no-api-key: add a provider key in the panel under "LLM provider".',
        };
      }
      try {
        const phrases = await suggestPhrases({
          provider: settings.provider,
          apiKey: settings.apiKey,
          existing: msg.existing,
          candidates: msg.candidates,
          ...(settings.model !== undefined ? { model: settings.model } : {}),
          ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
          spend: chromeStorageSpendChecker(),
        });
        return { t: 'suggestions', v: MESSAGE_VERSION, phrases };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { t: 'err', v: MESSAGE_VERSION, message };
      }
    }
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  // Content's itemStates broadcast reaches the SW as well as the panel
  // (chrome.runtime.sendMessage fans out to both). Piggy-back on it for
  // the per-tab badge: restored items are visible again, so only
  // still-hidden ones count.
  if (isContentToPanel(raw) && raw.t === 'itemStates') {
    const tabId = _sender.tab?.id;
    if (tabId !== undefined) {
      const hidden = raw.items.filter((i) => i.state === 'filtered').length;
      void chrome.action
        .setBadgeText({ tabId, text: hidden > 0 ? String(hidden) : '' })
        .catch(() => undefined);
    }
    return false;
  }
  if (!isPanelMsg(raw)) {
    // Stay silent on malformed messages — don't crash the channel for the
    // sender. A future bus migration (v:2) lives alongside v:1 here.
    return false;
  }

  // Async handler — keep the message port open by returning true. The
  // listener spec requires the literal `true` (not a truthy value).
  handle(raw)
    .then((reply) => sendResponse(reply))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const reply: SwToPanel = { t: 'err', v: MESSAGE_VERSION, message };
      sendResponse(reply);
    });
  return true;
});
