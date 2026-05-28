// shared/settings.ts — BYO-key + provider persistence.
//
// Decision #15 (DESIGN.md): the LLM key never lives in chrome.storage.sync.
// `storage.local` is per-profile, per-device — credentials don't cross the
// Google sync boundary by construction. Slice 6.5 (PRIVACY.md) restates
// this for the Web Store privacy doc.
//
// The same key never appears in any chrome.runtime / chrome.tabs message
// payload either: only the SW reads it (via `loadLlmSettings`) and uses it
// in the outbound provider `fetch` call. The panel reads/writes here for
// the settings UI. The 3.4 Playwright privacy gate enforces this at
// runtime by spying on the message bus.

import type { LlmProvider } from './types.js';

export interface LlmSettings {
  provider: LlmProvider;
  apiKey: string;
  /** Optional model override; the LLM call falls back to a per-provider
   *  default when undefined. */
  model?: string;
  /** Optional API base URL — lets users point at OpenAI-compatible /
   *  Anthropic-compatible proxies (OpenRouter, LiteLLM, vLLM, Ollama,
   *  etc.) instead of the upstream provider. The provider-specific
   *  path (`/v1/messages` or `/v1/chat/completions`) is appended by
   *  the call site. Trailing slashes are normalized. */
  baseUrl?: string;
}

const STORAGE_KEY = 'nf:llm-settings';

export async function loadLlmSettings(): Promise<LlmSettings | null> {
  const r = await chrome.storage.local.get([STORAGE_KEY]);
  const v = r[STORAGE_KEY];
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (obj['provider'] !== 'anthropic' && obj['provider'] !== 'openai') return null;
  if (typeof obj['apiKey'] !== 'string') return null;
  const out: LlmSettings = {
    provider: obj['provider'] as LlmProvider,
    apiKey: obj['apiKey'],
  };
  if (typeof obj['model'] === 'string' && obj['model'].trim() !== '') {
    out.model = obj['model'];
  }
  if (typeof obj['baseUrl'] === 'string' && obj['baseUrl'].trim() !== '') {
    out.baseUrl = obj['baseUrl'].trim();
  }
  return out;
}

export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export async function clearLlmSettings(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
