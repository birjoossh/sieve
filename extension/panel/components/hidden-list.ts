// panel/components/hidden-list.ts — HIDDEN (N) review surface.
//
// Renders one row per filtered-or-restored item, with restore ⇄ hide per row
// and restore-all ⇄ hide-all bulk actions. The component is stateless —
// the caller hands in the latest ItemSummary[] (mirrored from content via
// itemStates pushes) and the onSetItem / onSetAll callbacks drive the
// PanelToContent message dispatch.

import type { ItemSummary } from '../../shared/types.js';

export interface HiddenListState {
  /** Every item the content script knows about. The component filters down
   *  to `filtered` + `restored` rows itself; `passing` rows are not shown. */
  items: readonly ItemSummary[];
  onSetItem: (id: string, restored: boolean) => void;
  onSetAll: (restored: boolean) => void;
}

export function renderHiddenList(host: HTMLElement, state: HiddenListState): void {
  host.replaceChildren();

  const hidden = state.items.filter(
    (i) => i.state === 'filtered' || i.state === 'restored',
  );
  const restoredCount = hidden.filter((i) => i.state === 'restored').length;
  const allRestored = hidden.length > 0 && restoredCount === hidden.length;
  const allHidden = hidden.length > 0 && restoredCount === 0;

  const head = document.createElement('div');
  head.className = 'hidden-head';

  const h = document.createElement('h2');
  h.className = 'section-h';
  h.textContent = `Hidden (${hidden.length})`;
  head.appendChild(h);

  if (hidden.length === 0) {
    host.appendChild(head);
    const p = document.createElement('p');
    p.className = 'section-meta';
    p.textContent = 'Nothing is hidden yet — items that match your filters will show up here.';
    host.appendChild(p);
    return;
  }

  // Bulk-action row, inline with the heading.
  const bulk = document.createElement('div');
  bulk.className = 'bulk-actions';

  const restoreAll = document.createElement('button');
  restoreAll.type = 'button';
  restoreAll.className = 'bulk-btn btn btn-ghost btn-sm';
  restoreAll.dataset['action'] = 'restore-all';
  restoreAll.textContent = 'Restore all';
  restoreAll.disabled = allRestored;
  restoreAll.onclick = () => state.onSetAll(true);
  bulk.appendChild(restoreAll);

  const hideAll = document.createElement('button');
  hideAll.type = 'button';
  hideAll.className = 'bulk-btn btn btn-ghost btn-sm';
  hideAll.dataset['action'] = 'hide-all';
  hideAll.textContent = 'Hide all';
  hideAll.disabled = allHidden;
  hideAll.onclick = () => state.onSetAll(false);
  bulk.appendChild(hideAll);

  head.appendChild(bulk);
  host.appendChild(head);

  // Per-item rows.
  const ul = document.createElement('ul');
  ul.className = 'hidden-list';
  ul.dataset['role'] = 'hidden-list';
  for (const item of hidden) {
    const li = document.createElement('li');
    li.className = `hidden-row state-${item.state}`;
    li.dataset['itemId'] = item.id;
    li.dataset['state'] = item.state;

    const main = document.createElement('div');
    main.className = 'hidden-row-main';

    const label = document.createElement('span');
    label.className = 'item-label';
    label.textContent = item.label ?? item.id;
    main.appendChild(label);

    if (item.reason !== undefined) {
      const reason = document.createElement('span');
      reason.className = 'item-reason';
      reason.textContent = `matched “${item.reason}”`;
      main.appendChild(reason);
    }

    li.appendChild(main);

    const restored = item.state === 'restored';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'row-toggle btn btn-ghost btn-sm';
    toggle.dataset['action'] = restored ? 'hide' : 'restore';
    toggle.dataset['itemId'] = item.id;
    toggle.textContent = restored ? 'hide' : 'restore';
    toggle.setAttribute(
      'aria-label',
      `${restored ? 'hide' : 'restore'} ${item.label ?? item.id}`,
    );
    toggle.onclick = () => state.onSetItem(item.id, !restored);
    li.appendChild(toggle);

    ul.appendChild(li);
  }
  host.appendChild(ul);
}
