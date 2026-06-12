// panel/components/llm-settings.ts — BYO-key + provider select.
//
// Pure render function over `LlmSettings | null`. The caller (panel.ts)
// owns the load/save round-trip through chrome.storage.local — this
// component only emits an `onSave` event with the new value.
//
// Rendered as a collapsed <details> ("AI settings (optional)") because the
// key is strictly optional — free-text filtering works without it. The
// open/closed state is read back from the previous render so panel-wide
// re-renders don't snap the disclosure shut while the user is typing.
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
  /** 4.7 spend cap surface: when present AND a key is configured, the
   *  section appends a usage readout + cap-reached warning. The panel
   *  queries the ledger via background/spend.getSpendStatus(); this
   *  component just renders. */
  spend?: SpendStatus;
}

const PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai'] as const;

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

interface FieldSpec {
  id: string;
  label: string;
}

function fieldRow(spec: FieldSpec, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'field';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = spec.id;
  label.textContent = spec.label;
  control.id = spec.id;
  row.appendChild(label);
  row.appendChild(control);
  return row;
}

export function renderLlmSettings(host: HTMLElement, state: LlmSettingsState): void {
  const prevOpen =
    host.querySelector<HTMLDetailsElement>('details[data-role="llm-settings"]')?.open ?? false;
  host.replaceChildren();

  const details = document.createElement('details');
  details.className = 'ai-settings';
  details.dataset['role'] = 'llm-settings';
  details.open = prevOpen;

  const summary = document.createElement('summary');
  summary.className = 'ai-summary';
  summary.textContent = 'AI settings (optional)';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'ai-body';

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'Add your own provider key to unlock named-field and numeric filter discovery, ' +
    'plus phrase suggestions. Free-text filtering works without it.';
  body.appendChild(hint);

  // Provider select
  const select = document.createElement('select');
  select.className = 'select';
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
  body.appendChild(fieldRow({ id: 'llm-provider', label: 'Provider' }, select));

  // API key input
  const keyInput = document.createElement('input');
  keyInput.className = 'input';
  keyInput.type = 'password';
  keyInput.dataset['input'] = 'api-key';
  keyInput.placeholder = 'sk-…';
  keyInput.value = state.current?.apiKey ?? '';
  keyInput.autocomplete = 'off';
  body.appendChild(fieldRow({ id: 'llm-api-key', label: 'API key' }, keyInput));

  // Optional model override
  const modelInput = document.createElement('input');
  modelInput.className = 'input';
  modelInput.type = 'text';
  modelInput.dataset['input'] = 'model';
  modelInput.placeholder = 'Provider default';
  modelInput.value = state.current?.model ?? '';
  body.appendChild(fieldRow({ id: 'llm-model', label: 'Model (optional)' }, modelInput));

  // Optional base URL — point at OpenRouter / LiteLLM / Ollama /
  // anything OpenAI- or Anthropic-shape compatible.
  const baseUrlInput = document.createElement('input');
  baseUrlInput.className = 'input';
  baseUrlInput.type = 'text';
  baseUrlInput.dataset['input'] = 'base-url';
  baseUrlInput.placeholder = 'https://api.openai.com or https://openrouter.ai/api';
  baseUrlInput.value = state.current?.baseUrl ?? '';
  baseUrlInput.autocomplete = 'off';
  const baseUrlRow = fieldRow({ id: 'llm-base-url', label: 'Base URL (optional)' }, baseUrlInput);

  // OpenRouter speaks the OpenAI wire shape, so it rides the existing
  // `openai` provider + base-URL override rather than a new LlmProvider
  // value (which would leak a panel convenience into shared/types).
  const openRouterPreset = document.createElement('button');
  openRouterPreset.type = 'button';
  openRouterPreset.className = 'base-url-preset btn btn-ghost btn-sm';
  openRouterPreset.dataset['action'] = 'use-openrouter';
  openRouterPreset.textContent = 'Use OpenRouter';
  openRouterPreset.addEventListener('click', () => {
    baseUrlInput.value = 'https://openrouter.ai/api';
    baseUrlInput.focus();
  });
  baseUrlRow.appendChild(openRouterPreset);
  const syncPreset = (): void => {
    openRouterPreset.hidden = select.value !== 'openai';
  };
  select.addEventListener('change', syncPreset);
  syncPreset();

  body.appendChild(baseUrlRow);

  // Buttons + saved indicator
  const buttons = document.createElement('div');
  buttons.className = 'llm-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'llm-save btn btn-primary btn-sm';
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
    clearBtn.className = 'llm-clear btn btn-ghost btn-sm';
    clearBtn.dataset['action'] = 'clear-llm-settings';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => state.onClear?.());
    buttons.appendChild(clearBtn);
  }

  const configured = state.current !== null;
  const status = document.createElement('span');
  status.className = configured ? 'llm-status is-saved' : 'llm-status';
  status.dataset['role'] = 'llm-status';
  status.textContent = configured ? 'Key saved' : 'No key saved';
  buttons.appendChild(status);

  body.appendChild(buttons);

  // Usage meter is meaningless without a key — no calls can happen.
  if (state.spend && state.current !== null && state.current.apiKey.trim() !== '') {
    const usage = document.createElement('p');
    usage.className = 'llm-spend';
    usage.dataset['role'] = 'spend-usage';
    usage.textContent =
      `Usage: ${state.spend.dailyUsed} / ${state.spend.dailyCap} today · ` +
      `${state.spend.monthlyUsed} / ${state.spend.monthlyCap} this month`;
    body.appendChild(usage);

    if (state.spend.capReached) {
      const warn = document.createElement('p');
      warn.className = 'llm-spend-warn';
      warn.dataset['role'] = 'spend-cap-warning';
      warn.textContent =
        state.spend.cappedPeriod === 'day'
          ? 'Daily spend cap reached — discovery calls are paused until tomorrow.'
          : 'Monthly spend cap reached — discovery calls are paused until next month.';
      body.appendChild(warn);
    }
  }

  details.appendChild(body);
  host.appendChild(details);
}
