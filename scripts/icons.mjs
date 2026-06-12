#!/usr/bin/env node
// scripts/icons.mjs — render the brand mark → extension/icons/icon{16,32,48,128}.png.
//
// The mark ("Negative Filter", funnel-rows on emerald): three list rows
// narrowing like a funnel — white, soft white, amber — on the emerald tonal
// gradient tile. SVG master rendered at each manifest size in headless
// Chromium so the PNGs stay regenerable when the brand changes. Run
// `npm run build` after — esbuild copies icons into dist/.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'extension', 'icons');

const SIZES = [16, 32, 48, 128];

const mark = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  <g fill="#ffffff">
    <rect x="116" y="148" width="280" height="52" rx="26"/>
    <rect x="156" y="230" width="200" height="52" rx="26" opacity="0.78"/>
    <rect x="196" y="312" width="120" height="52" rx="26" fill="#fbbf24"/>
  </g>
</svg>`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const pg = await browser.newPage({ viewport: { width: size, height: size } });
      await pg.setContent(
        `<!doctype html><html><body style="margin:0">${mark(size)}</body></html>`,
      );
      await pg.screenshot({ path: resolve(OUT, `icon${size}.png`), omitBackground: true });
      await pg.close();
      console.log(`icon → extension/icons/icon${size}.png`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
