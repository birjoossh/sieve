// panel/components/page-status.ts — what we detected + (Slice 3.5)
// re-discover button + NL hint input.
//
// Slice 1: shows "detected: layout / N items" when a schema matched. The
// COLLAPSE | HIDE display-mode toggle that used to live here was removed on
// user feedback (bugs.md Bug 3): with the polarity control + per-item
// restore under Filters, the extra segmented control read as clutter.
// Filtered items always collapse to the sliver bar; the renderer still
// supports `setDisplayMode` over the message bus.
//
// Slice 3.5: a "Re-discover" button + an inline hint input. Clicking
// invokes `onRediscover({ hint, force: true })` so the orchestrator
// bypasses cache and forwards the hint into the LLM prompt. The block
// renders with or without a schema — the missing-schema error row points
// users here, and gating it on a schema made that advice a dead-end on
// exactly the pages that need it (content handles `rediscover` without a
// ctx by re-running discovery from scratch).

import type { Schema } from '../../shared/types.js';

export interface RediscoverPayload {
  hint?: string;
  force: true;
}

export interface PageStatusState {
  schema: Schema | null;
  itemCount: number;
  /** Optional: when wired, a "Re-discover" button + hint input render
   *  beneath the status line. Click → onRediscover({ hint, force: true }). */
  onRediscover?: (payload: RediscoverPayload) => void;
}

export function renderPageStatus(host: HTMLElement, state: PageStatusState): void {
  host.replaceChildren();

  const h = document.createElement('h2');
  h.className = 'section-h';
  h.textContent = 'Page';
  host.appendChild(h);

  const status = document.createElement('p');
  status.className = 'section-meta';
  // Schema-gated sentinel: specs (and any future panel code) key "the page
  // is detected" off this role now that the mode toggle no longer exists.
  status.dataset['role'] = state.schema ? 'page-detected' : 'page-empty';
  if (state.schema) {
    status.textContent = `Detected: ${state.schema.layout} · ${state.itemCount} item${state.itemCount === 1 ? '' : 's'}`;
  } else {
    status.textContent = 'No list detected yet.';
  }
  host.appendChild(status);

  if (state.onRediscover) {
    const rediscoverHandler = state.onRediscover;
    const rediscover = document.createElement('div');
    rediscover.className = 'rediscover';
    rediscover.dataset['role'] = 'rediscover';

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent = state.schema
      ? 'Wrong or missing items? Re-run detection — a short hint about the layout helps.'
      : 'Point detection at the list — a short hint like “job cards in the main column” helps.';
    rediscover.appendChild(help);

    const row = document.createElement('div');
    row.className = 'rediscover-row';

    const hintInput = document.createElement('input');
    hintInput.type = 'text';
    hintInput.dataset['input'] = 'rediscover-hint';
    hintInput.placeholder = 'e.g. “title is in the h3”';
    hintInput.className = 'rediscover-hint input';
    hintInput.setAttribute('aria-label', 'Re-discover hint');
    row.appendChild(hintInput);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rediscover-btn btn btn-secondary';
    btn.dataset['action'] = 'rediscover';
    btn.textContent = 'Re-discover';
    btn.addEventListener('click', () => {
      const hint = hintInput.value.trim();
      const payload: RediscoverPayload = { force: true };
      if (hint !== '') payload.hint = hint;
      rediscoverHandler(payload);
    });
    row.appendChild(btn);

    rediscover.appendChild(row);
    host.appendChild(rediscover);
  }
}
