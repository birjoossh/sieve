#!/usr/bin/env node
// scripts/store-tiles.mjs — render the Web Store promo tiles.
//
// The store wants a 440x280 small tile and (optionally) a 1400x560
// marquee. Rendering HTML in headless Chromium keeps the tiles
// pixel-perfect and regenerable when the copy or brand changes.
// Output → out/store-assets/.

import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'out', 'store-assets');

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
// Brand purple — matches icon128.png and the hero screenshot gradient.
const BG = `linear-gradient(135deg, #8a63f0 0%, #5b3df0 100%)`;

function page(width, height, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
    body { background: ${BG}; font-family: ${FONT};
           display: flex; align-items: center; justify-content: center;
           -webkit-font-smoothing: antialiased; }
    .col { display: flex; flex-direction: column; align-items: center; }
    .row { display: flex; align-items: center; }
    h1 { color: #fff; font-weight: 700; letter-spacing: -0.02em; }
    p  { color: rgba(255,255,255,0.85); }
    .chip { color: #fff; background: rgba(255,255,255,0.16);
            border: 1px solid rgba(255,255,255,0.28);
            border-radius: 999px; padding: 10px 22px;
            font-size: 21px; font-weight: 500; white-space: nowrap; }
  </style></head><body>${body}</body></html>`;
}

async function main() {
  const iconB64 = (await readFile(resolve(ROOT, 'extension/icons/icon128.png'))).toString('base64');
  const icon = (size, radius) =>
    `<img src="data:image/png;base64,${iconB64}" width="${size}" height="${size}"
          style="border-radius:${radius}px; box-shadow: 0 8px 28px rgba(20,10,60,0.35);">`;

  const tiles = [
    {
      name: 'tile-small-440x280.png',
      width: 440,
      height: 280,
      body: `<div class="col" style="gap:18px">
               ${icon(88, 20)}
               <div class="col" style="gap:6px">
                 <h1 style="font-size:34px">Negative Filter</h1>
                 <p style="font-size:17px">Hide what you don't want to see</p>
               </div>
             </div>`,
    },
    {
      name: 'marquee-1400x560.png',
      width: 1400,
      height: 560,
      body: `<div class="col" style="gap:40px">
               <div class="row" style="gap:36px">
                 ${icon(128, 28)}
                 <div>
                   <h1 style="font-size:76px">Negative Filter</h1>
                   <p style="font-size:32px; margin-top:8px">Hide what you don't want to see — on any site</p>
                 </div>
               </div>
               <div class="row" style="gap:18px">
                 <span class="chip">Any list, feed, or grid</span>
                 <span class="chip">Your keywords</span>
                 <span class="chip">No account · no tracking</span>
                 <span class="chip">Works without AI</span>
               </div>
             </div>`,
    },
  ];

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const t of tiles) {
      const pg = await browser.newPage({ viewport: { width: t.width, height: t.height } });
      await pg.setContent(page(t.width, t.height, t.body), { waitUntil: 'networkidle' });
      await pg.screenshot({ path: resolve(OUT, t.name) });
      await pg.close();
      console.log(`tile → out/store-assets/${t.name}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
