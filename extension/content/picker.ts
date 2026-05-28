// content/picker.ts — click-to-teach pick mode (Slice 2).
//
// User clicks "Pick an item" in the panel; the content script enters pick
// mode; hovering an element paints a transient outline so the user can see
// which DOM node will be sampled; clicking it commits the pick (or ESC
// cancels). 2.3 is just the hover-highlight half — selector generalization
// (2.4) reads the picked element and produces the schema selectors; the
// commit/cancel wiring lands with the panel button.
//
// Contract this module enforces:
//   - The outline is drawn by a single overlay <div> appended to <body>
//     when pick mode starts, removed when it stops. The page's own
//     elements are never touched (no inline styles, no added classes, no
//     attribute writes) so we can't possibly leak state into the page CSS
//     that the renderer or detect rely on.
//   - Exiting pick mode leaves nothing in the DOM that wasn't there before.
//
// The overlay uses `pointer-events: none` so the underlying element still
// receives the click that commits the pick.

const OVERLAY_ID = 'nf-pick-outline';

export interface PickerOptions {
  /** Optional callback when an element is hovered (post-overlay-update). */
  onHover?: (target: Element) => void;
}

export class Picker {
  private overlay: HTMLDivElement | null = null;
  private active = false;
  private lastTarget: Element | null = null;
  private readonly opts: PickerOptions;

  // Stable bound refs so removeEventListener actually matches on stop().
  private readonly onMove = (ev: MouseEvent): void => this.handleMove(ev);
  private readonly onScrollOrResize = (): void => this.repositionOverlay();

  constructor(opts: PickerOptions = {}) {
    this.opts = opts;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Begin pick mode. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.active) return;
    this.active = true;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646', // one below the max — keeps any future toast above us
      boxSizing: 'border-box',
      outline: '2px solid #1f6feb',
      outlineOffset: '0px',
      background: 'rgba(31, 111, 235, 0.08)',
      transition: 'top 60ms linear, left 60ms linear, width 60ms linear, height 60ms linear',
      display: 'none', // hidden until first hover with a real target
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
    });
    document.body.appendChild(overlay);
    this.overlay = overlay;

    document.addEventListener('mousemove', this.onMove, true);
    window.addEventListener('scroll', this.onScrollOrResize, true);
    window.addEventListener('resize', this.onScrollOrResize, true);
  }

  /** End pick mode. Removes the overlay and all listeners. Idempotent. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('scroll', this.onScrollOrResize, true);
    window.removeEventListener('resize', this.onScrollOrResize, true);
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
    this.lastTarget = null;
  }

  private handleMove(ev: MouseEvent): void {
    if (!this.active || !this.overlay) return;
    // elementFromPoint ignores our overlay (pointer-events:none) so it
    // returns the real underlying element.
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!target || target === this.lastTarget) return;
    this.lastTarget = target;
    this.paint(target);
    this.opts.onHover?.(target);
  }

  private paint(target: Element): void {
    if (!this.overlay) return;
    const rect = target.getBoundingClientRect();
    const o = this.overlay.style;
    o.display = 'block';
    o.top = `${rect.top}px`;
    o.left = `${rect.left}px`;
    o.width = `${rect.width}px`;
    o.height = `${rect.height}px`;
  }

  private repositionOverlay(): void {
    if (!this.active || !this.lastTarget) return;
    this.paint(this.lastTarget);
  }
}
