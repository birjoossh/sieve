// panel/components/filter-list.ts — single-filter phrase-chip editor.
//
// Slice 1 scope: one filter, hard-bound to the schema's `snippet` field, with
// the containsAny predicate. Add a phrase via the input → chip appears →
// caller hands the new list to the content script. Remove a chip via its ×.
//
// Slice 4 expands this to multi-filter, field picker, regex toggle, and
// structured predicates. Keep the prop surface narrow so the swap stays
// mechanical — the caller passes phrases in/out as a string[].

export interface FilterListState {
  /** Whether the host page actually has a list to filter. Slice-1
   *  rolecast-only — when false, the section renders a disabled
   *  placeholder rather than the editor. */
  enabled: boolean;
  phrases: string[];
  onChange: (phrases: string[]) => void;
  /** 4.5: when present, the section renders Save / Clear buttons so
   *  the current filter set can be persisted to storage.sync. The
   *  panel keeps track of whether saved set exists for the active
   *  fingerprint — `savedExists` toggles the Clear button on/off. */
  onSave?: () => void;
  onClearSaved?: () => void;
  savedExists?: boolean;
  /** 6.3: export / import the saved-filter sets across all
   *  fingerprints. Buttons render alongside Save when callbacks
   *  are supplied. `onImport(file)` is called with the FileList
   *  entry the user picked. */
  onExport?: () => void;
  onImport?: (file: File) => void;
  /** 4.8: when present, render a ✦ Suggest button. The host (panel)
   *  fetches phrasing suggestions from the LLM and re-renders with
   *  `suggestions` populated. Each suggestion has an Accept button
   *  that adds it to the phrase chips. */
  onSuggest?: () => void;
  suggestions?: string[];
  suggesting?: boolean;
  suggestError?: string;
  onAcceptSuggestion?: (phrase: string) => void;
  onDismissSuggestions?: () => void;
}

export function renderFilterList(host: HTMLElement, state: FilterListState): void {
  host.replaceChildren();

  const h = document.createElement('h2');
  h.className = 'section-h';
  h.textContent = 'Filters';
  host.appendChild(h);

  if (!state.enabled) {
    const p = document.createElement('p');
    p.className = 'section-meta';
    p.textContent = 'Enable a site with a detected list to filter.';
    host.appendChild(p);
    return;
  }

  const meta = document.createElement('p');
  meta.className = 'section-meta';
  meta.textContent = 'Hide items whose snippet contains any of:';
  host.appendChild(meta);

  // Chips — one per phrase. Use textContent (never innerHTML) since
  // phrases are user-supplied.
  const chips = document.createElement('div');
  chips.className = 'chips';
  chips.dataset['role'] = 'phrase-chips';
  for (const phrase of state.phrases) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset['phrase'] = phrase;

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = phrase;
    chip.appendChild(label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.dataset['action'] = 'remove-phrase';
    remove.dataset['phrase'] = phrase;
    remove.setAttribute('aria-label', `remove ${phrase}`);
    remove.textContent = '×';
    remove.onclick = () => state.onChange(state.phrases.filter((p) => p !== phrase));
    chip.appendChild(remove);

    chips.appendChild(chip);
  }
  host.appendChild(chips);

  // Add-phrase form. Form submission, not button click, so Enter works.
  const form = document.createElement('form');
  form.className = 'phrase-form';
  form.dataset['role'] = 'add-phrase';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'phrase-input';
  input.placeholder = 'add a phrase…';
  input.dataset['input'] = 'phrase';
  input.autocomplete = 'off';
  form.appendChild(input);

  const add = document.createElement('button');
  add.type = 'submit';
  add.className = 'phrase-add';
  add.textContent = 'Add';
  form.appendChild(add);

  form.onsubmit = (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value.length === 0) return;
    if (state.phrases.includes(value)) {
      input.value = '';
      return;
    }
    state.onChange([...state.phrases, value]);
    input.value = '';
  };
  host.appendChild(form);

  if (state.onSuggest) {
    const suggestRow = document.createElement('div');
    suggestRow.className = 'suggest-row';
    suggestRow.dataset['role'] = 'suggest-row';

    const suggestBtn = document.createElement('button');
    suggestBtn.type = 'button';
    suggestBtn.className = 'suggest-btn';
    suggestBtn.dataset['action'] = 'suggest-phrases';
    suggestBtn.textContent = state.suggesting ? '✦ …' : '✦ Suggest phrases';
    suggestBtn.disabled = !!state.suggesting;
    suggestBtn.onclick = () => state.onSuggest?.();
    suggestRow.appendChild(suggestBtn);

    if (state.suggestError) {
      const err = document.createElement('span');
      err.className = 'suggest-error';
      err.dataset['role'] = 'suggest-error';
      err.textContent = state.suggestError;
      suggestRow.appendChild(err);
    }

    host.appendChild(suggestRow);

    if (state.suggestions && state.suggestions.length > 0) {
      const list = document.createElement('div');
      list.className = 'suggest-list';
      list.dataset['role'] = 'suggest-list';
      for (const s of state.suggestions) {
        const pill = document.createElement('span');
        pill.className = 'suggest-pill';
        pill.dataset['suggestion'] = s;

        const label = document.createElement('span');
        label.className = 'suggest-label';
        label.textContent = s;
        pill.appendChild(label);

        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'suggest-accept';
        accept.dataset['action'] = 'accept-suggestion';
        accept.dataset['suggestion'] = s;
        accept.setAttribute('aria-label', `accept ${s}`);
        accept.textContent = '+';
        accept.onclick = () => state.onAcceptSuggestion?.(s);
        pill.appendChild(accept);

        list.appendChild(pill);
      }

      if (state.onDismissSuggestions) {
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'suggest-dismiss';
        dismiss.dataset['action'] = 'dismiss-suggestions';
        dismiss.textContent = 'Dismiss';
        dismiss.onclick = () => state.onDismissSuggestions?.();
        list.appendChild(dismiss);
      }

      host.appendChild(list);
    }
  }

  if (state.onSave) {
    const actions = document.createElement('div');
    actions.className = 'filter-actions';
    actions.dataset['role'] = 'save-row';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'filter-save';
    saveBtn.dataset['action'] = 'save-filters';
    saveBtn.textContent = 'Save filters';
    saveBtn.onclick = () => state.onSave?.();
    actions.appendChild(saveBtn);

    if (state.onClearSaved && state.savedExists) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'filter-clear-saved';
      clearBtn.dataset['action'] = 'clear-saved-filters';
      clearBtn.textContent = 'Clear saved';
      clearBtn.onclick = () => state.onClearSaved?.();
      actions.appendChild(clearBtn);
    }

    if (state.savedExists) {
      const badge = document.createElement('span');
      badge.className = 'filter-saved-badge';
      badge.dataset['role'] = 'saved-badge';
      badge.textContent = 'saved';
      actions.appendChild(badge);
    }

    if (state.onExport) {
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'filter-export';
      exportBtn.dataset['action'] = 'export-filters';
      exportBtn.textContent = 'Export';
      exportBtn.onclick = () => state.onExport?.();
      actions.appendChild(exportBtn);
    }

    if (state.onImport) {
      const importLabel = document.createElement('label');
      importLabel.className = 'filter-import';
      importLabel.dataset['role'] = 'import-row';
      importLabel.textContent = 'Import ';
      const importInput = document.createElement('input');
      importInput.type = 'file';
      importInput.dataset['input'] = 'import-file';
      importInput.accept = 'application/json,.json';
      importInput.onchange = () => {
        const file = importInput.files?.[0];
        if (file) state.onImport?.(file);
        importInput.value = '';
      };
      importLabel.appendChild(importInput);
      actions.appendChild(importLabel);
    }

    host.appendChild(actions);
  }
}
