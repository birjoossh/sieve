// panel/components/error-panel.ts — surfaces failure-mode messages.
//
// Slice 6.4 collects the three failure modes the user might hit into
// one place so each gets a clear, action-oriented message instead of
// silent breakage:
//
//   1. missing-schema — content script is loaded but no item-set
//      matched on this page. We tell the user how to teach it (the
//      Re-discover button in page-status, hint input).
//   2. spend-cap — daily/monthly LLM cap reached. Mirrors the spend
//      warning in llm-settings (4.7); listed here as a single source
//      so the user notices it regardless of which section they look
//      at first.
//   3. llm-error — the most recent discoverSchema / suggestPhrases
//      call threw. Surfaced as a short message + a hint to retry.
//
// Pure renderer. The panel owns the error derivation and passes the
// resulting array in; this component just maps each error to its DOM
// row. Test seam: each row has `data-error="<kind>"` so the spec can
// assert presence without coupling to copy.

export type ErrorKind = 'missing-schema' | 'spend-cap' | 'llm-error' | 'unsafe-regex';

export interface PanelError {
  kind: ErrorKind;
  message: string;
}

export interface ErrorPanelState {
  errors: readonly PanelError[];
}

const TITLES: Record<ErrorKind, string> = {
  'missing-schema': 'No filterable list on this page',
  'spend-cap': 'Spend cap reached',
  'llm-error': 'LLM call failed',
  'unsafe-regex': 'Filter regex rejected',
};

const HINTS: Record<ErrorKind, string> = {
  'missing-schema':
    'Use Re-discover (above) with a one-line hint like “job cards in the main column” to teach the layout.',
  'spend-cap':
    'Discovery calls are paused until the cap window resets. Use saved filters in the meantime.',
  'llm-error':
    'Re-try; if it persists, recheck your provider key under LLM provider.',
  'unsafe-regex':
    'The filter regex was rejected by the safety pre-check (length or nested quantifier). Tighten the pattern.',
};

export function renderErrorPanel(host: HTMLElement, state: ErrorPanelState): void {
  host.replaceChildren();
  if (state.errors.length === 0) return;

  const h = document.createElement('h2');
  h.className = 'section-h';
  h.textContent = 'Heads up';
  host.appendChild(h);

  for (const err of state.errors) {
    const row = document.createElement('div');
    row.className = `panel-error error-${err.kind}`;
    row.dataset['error'] = err.kind;
    row.setAttribute('role', 'status');

    const title = document.createElement('strong');
    title.className = 'panel-error-title';
    title.textContent = TITLES[err.kind];
    row.appendChild(title);

    const msg = document.createElement('p');
    msg.className = 'panel-error-message';
    msg.textContent = err.message;
    row.appendChild(msg);

    const hint = document.createElement('p');
    hint.className = 'panel-error-hint';
    hint.textContent = HINTS[err.kind];
    row.appendChild(hint);

    host.appendChild(row);
  }
}
