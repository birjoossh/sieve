// panel/components/page-status.ts — what we detected + display-mode toggle
// + (Slice 3.5) re-discover button + NL hint input.
//
// Slice 1: shows "detected: layout / N items" when a schema matched, and a
// COLLAPSE | HIDE segmented toggle wired to the renderer's `.mode-hide`
// class on the item-set container. Toggling here is what the 1.8 gate
// asserts.
//
// Slice 3.5: a "Re-discover" button + an inline hint input. Clicking
// invokes `onRediscover({ hint, force: true })` so the orchestrator
// bypasses cache and forwards the hint into the LLM prompt. The button is
// only shown when there's a schema to re-discover against.

import type { DisplayMode, Schema } from '../../shared/types.js';

export interface RediscoverPayload {
  hint?: string;
  force: true;
}

export interface PageStatusState {
  schema: Schema | null;
  itemCount: number;
  mode: DisplayMode;
  onModeChange: (mode: DisplayMode) => void;
  /** Optional: when wired, a "Re-discover" button + hint input render
   *  beneath the mode toggle. Click → onRediscover({ hint, force: true }). */
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
  if (state.schema) {
    status.textContent = `Detected: ${state.schema.layout} · ${state.itemCount} item${state.itemCount === 1 ? '' : 's'}`;
  } else {
    status.textContent = 'No list detected.';
  }
  host.appendChild(status);

  if (!state.schema) return;

  const toggle = document.createElement('div');
  toggle.className = 'mode-toggle';
  toggle.dataset['role'] = 'display-mode';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Display mode');

  for (const m of ['collapse', 'hide'] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-btn';
    btn.dataset['mode'] = m;
    btn.textContent = m === 'collapse' ? 'Collapse' : 'Hide';
    btn.setAttribute('aria-pressed', String(state.mode === m));
    if (state.mode === m) btn.classList.add('active');
    btn.onclick = () => state.onModeChange(m);
    toggle.appendChild(btn);
  }

  host.appendChild(toggle);

  if (state.onRediscover) {
    const rediscoverHandler = state.onRediscover;
    const rediscover = document.createElement('div');
    rediscover.className = 'rediscover';
    rediscover.dataset['role'] = 'rediscover';

    const hintInput = document.createElement('input');
    hintInput.type = 'text';
    hintInput.dataset['input'] = 'rediscover-hint';
    hintInput.placeholder = 'Hint (optional, e.g. "title is in the h3")';
    hintInput.className = 'rediscover-hint';
    rediscover.appendChild(hintInput);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rediscover-btn';
    btn.dataset['action'] = 'rediscover';
    btn.textContent = 'Re-discover';
    btn.addEventListener('click', () => {
      const hint = hintInput.value.trim();
      const payload: RediscoverPayload = { force: true };
      if (hint !== '') payload.hint = hint;
      rediscoverHandler(payload);
    });
    rediscover.appendChild(btn);

    host.appendChild(rediscover);
  }
}
