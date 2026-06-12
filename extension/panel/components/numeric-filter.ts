// panel/components/numeric-filter.ts — threshold editor for the numeric
// Slice-4.1 predicates (`lessThan` / `greaterThan`).
//
// The Slice-1 chip editor handles `containsAny`. 4.4 added the structured-
// value pair for numeric fields: a below/above op toggle, a threshold
// input, and an enable checkbox. The hosting panel pushes a second Filter
// whenever the editor is enabled; the engine ANDs it with the phrase
// filter per 4.3.
//
// The original widget was a 0–300 "$k" slider sized for the rolecast
// stub's comp field. Real prices ("HK$4,000" on Carousell — bugs.md #2)
// don't fit a fixed range or a $k unit, so the threshold is a free
// number input now: the field's scale is page knowledge the panel
// doesn't have. The onChange wiring re-pushes filters on every input —
// engine evaluation is fast and the editor feels live.

export type NumericOp = 'lessThan' | 'greaterThan';

export interface NumericFilterValue {
  enabled: boolean;
  op: NumericOp;
  value: number;
}

export interface NumericFilterState {
  enabled: boolean;
  current: NumericFilterValue;
  /** Humanized field label for the enable row — "Comp", "Price", … The
   *  raw schema field name never reaches the UI. */
  label: string;
  onChange: (next: NumericFilterValue) => void;
}

const OP_LABELS: Record<NumericOp, string> = {
  lessThan: 'below',
  greaterThan: 'above',
};

export function renderNumericFilter(host: HTMLElement, state: NumericFilterState): void {
  host.replaceChildren();

  const h = document.createElement('h2');
  h.className = 'section-h';
  h.textContent = 'Numeric filter';
  host.appendChild(h);

  if (!state.enabled) {
    const p = document.createElement('p');
    p.className = 'section-meta';
    p.textContent = 'Available when the detected list has numeric fields.';
    host.appendChild(p);
    return;
  }

  // Enable checkbox — gates the editor row. When unchecked, the panel
  // omits the numeric filter from the pushed list and the engine sees
  // only the phrase filter.
  const enableRow = document.createElement('label');
  enableRow.className = 'numeric-enable';
  const enableInput = document.createElement('input');
  enableInput.type = 'checkbox';
  enableInput.dataset['input'] = 'numeric-enabled';
  enableInput.checked = state.current.enabled;
  enableInput.onchange = () => {
    state.onChange({ ...state.current, enabled: enableInput.checked });
  };
  enableRow.appendChild(enableInput);
  const enableText = document.createElement('span');
  enableText.textContent = `Filter by ${state.label}`;
  enableRow.appendChild(enableText);
  host.appendChild(enableRow);

  const row = document.createElement('div');
  row.className = 'numeric-row';
  row.dataset['role'] = 'numeric-row';

  const hideLabel = document.createElement('span');
  hideLabel.className = 'numeric-hide-label';
  hideLabel.textContent = 'Hide';
  row.appendChild(hideLabel);

  // Op select — hide items below / above the threshold. (We model the
  // polarity at the Filter level — exclude. So "below 200" reads
  // "exclude items whose value is under 200".)
  const opSelect = document.createElement('select');
  opSelect.className = 'numeric-op select';
  opSelect.dataset['input'] = 'numeric-op';
  opSelect.setAttribute('aria-label', `Hide ${state.label} below or above`);
  for (const op of ['lessThan', 'greaterThan'] as const) {
    const opt = document.createElement('option');
    opt.value = op;
    opt.textContent = OP_LABELS[op];
    if (op === state.current.op) opt.selected = true;
    opSelect.appendChild(opt);
  }
  opSelect.onchange = () => {
    state.onChange({ ...state.current, op: opSelect.value as NumericOp });
  };
  row.appendChild(opSelect);

  const value = document.createElement('input');
  value.type = 'number';
  value.className = 'numeric-value input';
  value.dataset['input'] = 'numeric-value';
  value.setAttribute('aria-label', `${state.label} threshold`);
  value.value = String(state.current.value);
  value.oninput = () => {
    const n = Number(value.value);
    if (value.value !== '' && Number.isFinite(n)) {
      state.onChange({ ...state.current, value: n });
    }
  };
  row.appendChild(value);

  host.appendChild(row);
}
