// panel/components/deep-toggle.ts — deep-scan toggle + first-use modal.
//
// 5.6 — when the user enables deep-scan for the first time, surface a
// ToS warning modal so they consciously opt in to the additional
// hidden-tab fetches the deep path makes. Dismissing the modal sets
// the persistent "deep-warning-dismissed" flag in storage.local; on
// later enables, no modal — just the toggle flip.
//
// Rendered as part of page-status. The host (panel.ts) owns the
// storage round-trip and provides the dismissed flag + the
// onDismissWarning callback that persists it.

export interface DeepToggleState {
  enabled: boolean;
  deepOn: boolean;
  warningDismissed: boolean;
  /** Shown while the modal is open. Cleared on dismiss. */
  modalOpen: boolean;
  onToggleDeep: (next: boolean) => void;
  onDismissWarning: () => void;
}

export function renderDeepToggle(host: HTMLElement, state: DeepToggleState): void {
  host.replaceChildren();
  if (!state.enabled) return;

  const row = document.createElement('label');
  row.className = 'deep-toggle';
  row.dataset['role'] = 'deep-toggle-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset['input'] = 'deep-scan';
  input.checked = state.deepOn;
  input.onchange = () => state.onToggleDeep(input.checked);
  row.appendChild(input);
  row.appendChild(document.createTextNode(' Deep scan (opens hidden tabs)'));
  host.appendChild(row);

  if (state.modalOpen) {
    const modal = document.createElement('div');
    modal.className = 'deep-modal';
    modal.dataset['role'] = 'deep-warning-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.className = 'deep-modal-title';
    title.textContent = 'Deep scan opens hidden tabs';
    modal.appendChild(title);

    const body = document.createElement('p');
    body.className = 'deep-modal-body';
    body.textContent =
      'Deep filters fetch each item’s detail page in a hidden background tab. ' +
      'Some sites prohibit automated access in their Terms of Service — ' +
      'using deep scan there may violate those terms. You alone are responsible ' +
      'for compliance with the sites you visit.';
    modal.appendChild(body);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'deep-modal-dismiss';
    dismiss.dataset['action'] = 'dismiss-deep-warning';
    dismiss.textContent = 'I understand';
    dismiss.onclick = () => state.onDismissWarning();
    modal.appendChild(dismiss);

    host.appendChild(modal);
  }
}
