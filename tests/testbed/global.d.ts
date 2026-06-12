// Ambient declarations so Playwright specs can reference `window.__nf`
// without a per-call cast. The surface is the single TestbedAPI defined in
// `tests/testbed/runtime.ts` — derived here so the two can never drift.

import type { Renderer } from '../../extension/content/renderer.js';
import type { TestbedAPI } from './runtime.js';

declare global {
  interface NFTestbed extends TestbedAPI {}

  interface Window {
    __nf: NFTestbed;
    __nfRenderer: Renderer;
  }
}

export {};
