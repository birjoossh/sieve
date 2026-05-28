// panel/components/settings.ts — per-domain enable / BYO key / spend cap /
// display mode.
//
// 0.4 landed the bare "Enable on this site" label tracking the active tab.
// 0.6 promotes it to a toggle: when the origin already has a registered
// content script, the button reads "Disable on <origin>" and the click
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

const BTN_SELECTOR = 'button[data-action="enable-site"]';

export function renderEnableButton(host: HTMLElement, state: EnableSiteState): void {
  let btn = host.querySelector<HTMLButtonElement>(BTN_SELECTOR);
  if (!btn) {
    btn = document.createElement('button');
    btn.dataset['action'] = 'enable-site';
    btn.className = 'enable-site';
    host.appendChild(btn);
  }

  if (state.origin === null) {
    btn.textContent = 'No enableable site';
    btn.disabled = true;
    btn.onclick = null;
    btn.dataset['enabled'] = 'false';
    return;
  }

  const origin = state.origin; // narrow for the closures below
  btn.disabled = false;

  if (state.enabled) {
    btn.textContent = `Disable on ${origin}`;
    btn.dataset['enabled'] = 'true';
    btn.onclick = () => state.onDisable?.(origin);
  } else {
    btn.textContent = `Enable on ${origin}`;
    btn.dataset['enabled'] = 'false';
    btn.onclick = () => state.onEnable?.(origin);
  }
}
