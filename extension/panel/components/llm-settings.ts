// panel/components/llm-settings.ts — BYO-key + provider select.
//
// Pure render function over `LlmSettings | null`. The caller (panel.ts)
// owns the load/save round-trip through chrome.storage.local — this
// component only emits an `onSave` event with the new value.
//
// The key field uses `type="password"` purely for shoulder-surfing —
// values are still serialized in plain DOM (`input.value`). The test
// reads the value back via that API to assert persistence.

import type { LlmProvider } from '../../shared/types.js';
import type { LlmSettings } from '../../shared/settings.js';
import type { SpendStatus } from '../../background/spend.js';

export interface LlmSettingsState {
  /** Current persisted settings, or null when nothing is saved yet. */
  current: LlmSettings | null;
  onSave: (next: LlmSettings) => void;
  /** Fires when the user clicks "Clear". */
  onClear?: () => void;
  /** 4.7 spend cap surface: when present, the section appends a usage
   *  readout + cap-reached warning. The panel queries the ledger via
   *  background/spend.getSpendStatus(); this component just renders. */
  spend?: SpendStatus;
}

const PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai'] as const;

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

export function renderLlmSettings(host: HTMLElement, state: LlmSettingsState): void {
  host.innerHTML = '';

  const fieldset = document.createElement('fieldset');
  fieldset.className = 'llm-settings';
  fieldset.dataset['role'] = 'llm-settings';

  const legend = document.createElement('legend');
  legend.textContent = 'LLM provider (BYO key)';
  fieldset.appendChild(legend);

  // Provider select
  const providerRow = document.createElement('label');
  providerRow.className = 'llm-row';
  providerRow.textContent = 'Provider: ';
  const select = document.createElement('select');
  select.dataset['input'] = 'provider';
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = PROVIDER_LABEL[p];
    if (state.current?.provider === p) opt.selected = true;
    select.appendChild(opt);
  }
  if (state.current === null) {
    // Default new selection to anthropic.
    select.value = 'anthropic';
  }
  providerRow.appendChild(select);
  fieldset.appendChild(providerRow);

  // API key input
  const keyRow = document.createElement('label');
  keyRow.className = 'llm-row';
  keyRow.textContent = 'API key: ';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.dataset['input'] = 'api-key';
  keyInput.placeholder = 'sk-...';
  keyInput.value = state.current?.apiKey ?? '';
  keyInput.autocomplete = 'off';
  keyRow.appendChild(keyInput);
  fieldset.appendChild(keyRow);

  // Optional model override
  const modelRow = document.createElement('label');
  modelRow.className = 'llm-row';
  modelRow.textContent = 'Model (optional): ';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.dataset['input'] = 'model';
  modelInput.placeholder = 'default';
  modelInput.value = state.current?.model ?? '';
  modelRow.appendChild(modelInput);
  fieldset.appendChild(modelRow);

  // Optional base URL — point at OpenRouter / LiteLLM / Ollama /
  // anything OpenAI- or Anthropic-shape compatible.
  const baseUrlRow = document.createElement('label');
  baseUrlRow.className = 'llm-row';
  baseUrlRow.textContent = 'Base URL (optional): ';
  const baseUrlInput = document.createElement('input');
  baseUrlInput.type = 'text';
  baseUrlInput.dataset['input'] = 'base-url';
  baseUrlInput.placeholder = 'https://api.anthropic.com or https://openrouter.ai/api';
  baseUrlInput.value = state.current?.baseUrl ?? '';
  baseUrlInput.autocomplete = 'off';
  baseUrlRow.appendChild(baseUrlInput);
  fieldset.appendChild(baseUrlRow);

  // Buttons
  const buttons = document.createElement('div');
  buttons.className = 'llm-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'llm-save';
  saveBtn.dataset['action'] = 'save-llm-settings';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const next: LlmSettings = {
      provider: select.value as LlmProvider,
      apiKey: keyInput.value,
    };
    const model = modelInput.value.trim();
    if (model !== '') next.model = model;
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl !== '') next.baseUrl = baseUrl;
    state.onSave(next);
  });
  buttons.appendChild(saveBtn);

  if (state.onClear) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'llm-clear';
    clearBtn.dataset['action'] = 'clear-llm-settings';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => state.onClear?.());
    buttons.appendChild(clearBtn);
  }

  fieldset.appendChild(buttons);

  // Saved indicator
  const status = document.createElement('span');
  status.className = 'llm-status';
  status.dataset['role'] = 'llm-status';
  status.textContent = state.current === null ? '(not configured)' : '(saved)';
  fieldset.appendChild(status);

  if (state.spend) {
    const usage = document.createElement('p');
    usage.className = 'llm-spend';
    usage.dataset['role'] = 'spend-usage';
    usage.textContent =
      `${state.spend.dailyUsed} / ${state.spend.dailyCap} today · ` +
      `${state.spend.monthlyUsed} / ${state.spend.monthlyCap} this month`;
    fieldset.appendChild(usage);

    if (state.spend.capReached) {
      const warn = document.createElement('p');
      warn.className = 'llm-spend-warn';
      warn.dataset['role'] = 'spend-cap-warning';
      warn.textContent =
        state.spend.cappedPeriod === 'day'
          ? 'Daily spend cap reached — discovery calls are paused until tomorrow.'
          : 'Monthly spend cap reached — discovery calls are paused until next month.';
      fieldset.appendChild(warn);
    }
  }

  host.appendChild(fieldset);
}
