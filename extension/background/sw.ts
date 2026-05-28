// background/sw.ts — service worker entry.
//
// MV3 reality: this worker can be terminated any time. Anything that must
// persist goes through chrome.storage + chrome.alarms, never in-memory globals.
// chrome.scripting.registerContentScripts is itself persistent across SW
// restarts (Chrome stores the registration table), so the enableDomain path
// is durable without our own bookkeeping.

import {
  isPanelMsg,
  MESSAGE_VERSION,
  originMatchPattern,
  scriptIdFor,
  type PanelMsg,
  type SwToPanel,
} from '../shared/types.js';
import { chromeStorageSchemaCache, getOrDiscover } from './cache.js';
import { loadLlmSettings } from '../shared/settings.js';
import { chromeStorageSpendChecker } from './spend.js';

const CONTENT_SCRIPT_FILE = 'content.js';

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
        // Honor the spend cap on the production path. The LLM call
        // itself doesn't yet take opts.spend at this site — we mirror
        // the meter by hand here so a successful discoverSchema bumps
        // the daily count visibly in the panel.
        // (We move this inside discoverSchema once the SW path takes a
        // spend hook directly.)
        await chromeStorageSpendChecker().recordSpend(Date.now());
        return { t: 'schema', v: MESSAGE_VERSION, schema };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { t: 'err', v: MESSAGE_VERSION, message };
      }
    }
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
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
