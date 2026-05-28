// panel/components/numeric-filter.ts — slider + units editor for the
// numeric Slice-4.1 predicates (`lessThan` / `greaterThan`).
//
// The Slice-1 chip editor handles `containsAny`. 4.4 adds the structured-
// value pair for numeric fields: a slider with a units suffix, a `<`/`>`
// op toggle, and an enable checkbox. The hosting panel pushes a second
// Filter whenever the editor is enabled; the engine ANDs it with the
// phrase filter per 4.3.
//
// Scope kept narrow on purpose: one numeric filter, field hardcoded to
// `comp` (the only numeric field on the rolecast stub). Field picker +
// per-field min/max land alongside LLM discovery in Slice 4-late when
// the schema's number fields are no longer a one-element set.
//
// Drag UX: the spec drives `input[type=range]` via `fill(value)` which
// fires `input` events. The onChange wiring re-pushes filters on every
// input — engine evaluation is fast and the slider feels live. (We
// don't debounce; a typical user makes ~20 input events per drag and
// the engine is sub-ms per item.)

export type NumericOp = 'lessThan' | 'greaterThan';

export interface NumericFilterValue {
  enabled: boolean;
  op: NumericOp;
  value: number;
}

export interface NumericFilterState {
  enabled: boolean;
  current: NumericFilterValue;
  /** Display unit suffix appended to the slider readout — "k$",
   *  "years", "kg", etc. Stored on the filter row, not the schema. */
  unit: string;
  /** Slider range. Inclusive on both ends. */
  min: number;
  max: number;
  step: number;
  onChange: (next: NumericFilterValue) => void;
}

const OP_LABELS: Record<NumericOp, string> = {
  lessThan: '<',
  greaterThan: '>',
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
    p.textContent = 'Enable a site with numeric fields to filter.';
    host.appendChild(p);
    return;
  }

  // Enable checkbox — gates the slider row. When unchecked, the panel
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
  enableRow.appendChild(document.createTextNode(' Filter by comp'));
  host.appendChild(enableRow);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'numeric-row';
  sliderRow.dataset['role'] = 'numeric-slider-row';

  // Op select — `<` or `>`. (We model the polarity at the Filter level
  // — exclude. So "< 200" reads "exclude comp under 200".)
  const opSelect = document.createElement('select');
  opSelect.className = 'numeric-op';
  opSelect.dataset['input'] = 'numeric-op';
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
  sliderRow.appendChild(opSelect);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'numeric-slider';
  slider.dataset['input'] = 'numeric-value';
  slider.min = String(state.min);
  slider.max = String(state.max);
  slider.step = String(state.step);
  slider.value = String(state.current.value);
  slider.oninput = () => {
    const n = Number(slider.value);
    if (Number.isFinite(n)) {
      readout.textContent = `${n} ${state.unit}`;
      state.onChange({ ...state.current, value: n });
    }
  };
  sliderRow.appendChild(slider);

  const readout = document.createElement('span');
  readout.className = 'numeric-readout';
  readout.dataset['role'] = 'numeric-readout';
  readout.textContent = `${state.current.value} ${state.unit}`;
  sliderRow.appendChild(readout);

  host.appendChild(sliderRow);
}
