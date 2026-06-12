// panel/components/settings.ts — per-domain enable / disable + first-run card.
//
// 0.4 landed the bare "Enable on this site" label tracking the active tab.
// 0.6 promotes it to a toggle: when the origin already has a registered
// content script, the button reads "Disable on <hostname>" and the click
// handler tears the registration down. Determination of enabled-state is
// the caller's job (panel.ts queries chrome.scripting); this component
// stays a pure render function.
//
// Per BUILD_PLAN.md the panel is a thin renderer over service-worker truth —
// we don't keep enable-state in panel-local memory.

export interface EnableSiteState {
  /** Origin of the current content tab, or null if there's nothing enableable
   *  (chrome://, about:blank, the extension itself, etc.). */
  origin: string | null;
  /** Whether this origin currently has a content-script registration. The
   *  caller resolves this before invoking us (typically via
   *  chrome.scripting.getRegisteredContentScripts). Ignored when origin is
   *  null. */
  enabled: boolean;
  /** Invoked when the user clicks while disabled. The handler is expected to
   *  drive chrome.permissions.request + sendToSw({t:'enableDomain'}). */
  onEnable?: ((origin: string) => void) | undefined;
  /** Invoked when the user clicks while enabled. The handler drives
   *  sendToSw({t:'disableDomain'}) and (optionally) permission revocation. */
  onDisable?: ((origin: string) => void) | undefined;
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.dataset['action'] = 'enable-site';
  btn.className = 'enable-site btn';
  return btn;
}

export function renderEnableButton(host: HTMLElement, state: EnableSiteState): void {
  host.replaceChildren();
  const btn = makeButton();

  if (state.origin === null) {
    const wrap = document.createElement('div');
    wrap.className = 'first-run';

    const title = document.createElement('h2');
    title.className = 'first-run-title';
    title.textContent = 'Hide what you don’t want to see';
    wrap.appendChild(title);

    const body = document.createElement('p');
    body.className = 'first-run-body';
    body.textContent =
      'Open a regular website tab — a job board, search results, a feed — ' +
      'and Negative Filter can hide the items you don’t care about.';
    wrap.appendChild(body);

    btn.textContent = 'No enableable site';
    btn.disabled = true;
    btn.dataset['enabled'] = 'false';
    btn.classList.add('btn-secondary', 'btn-block');
    wrap.appendChild(btn);

    host.appendChild(wrap);
    return;
  }

  const origin = state.origin; // narrow for the closures below
  const hostname = hostnameOf(origin);
  btn.disabled = false;

  if (state.enabled) {
    const row = document.createElement('div');
    row.className = 'site-row';

    const badge = document.createElement('span');
    badge.className = 'badge badge-ok';
    badge.textContent = 'Active';
    row.appendChild(badge);

    btn.textContent = `Disable on ${hostname}`;
    btn.dataset['enabled'] = 'true';
    btn.classList.add('btn-ghost', 'btn-sm');
    btn.onclick = () => state.onDisable?.(origin);
    row.appendChild(btn);

    host.appendChild(row);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'first-run';

  const title = document.createElement('h2');
  title.className = 'first-run-title';
  title.textContent = 'Hide what you don’t want to see';
  wrap.appendChild(title);

  const body = document.createElement('p');
  body.className = 'first-run-body';
  body.textContent =
    'Negative Filter hides items from list pages — job boards, search results, ' +
    'feeds — based on phrases and limits you choose. Turn it on for this site to start.';
  wrap.appendChild(body);

  btn.textContent = `Enable on ${hostname}`;
  btn.dataset['enabled'] = 'false';
  btn.classList.add('btn-primary', 'btn-block');
  btn.onclick = () => state.onEnable?.(origin);
  wrap.appendChild(btn);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'If nothing changes right away, reload the tab once after enabling.';
  wrap.appendChild(note);

  host.appendChild(wrap);
}
