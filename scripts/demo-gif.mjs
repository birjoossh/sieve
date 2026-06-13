#!/usr/bin/env node
// scripts/demo-gif.mjs — record an animated-GIF product demo of Negative
// Filter driving the REAL extension on a local fixture.
//
// Loads dist/ as an unpacked extension (host_permissions baked to <all_urls>
// so the enable flow needs no prompt, exactly like tests/testbed/ext-env.ts),
// opens the rolecast job-board fixture + the side panel, and walks the core
// user workflow — enable, type a phrase, watch items collapse, stack a second
// filter, restore one — screenshotting the page + panel at each step. A Python
// (Pillow) pass composites each step side-by-side under a branded caption bar
// and assembles the frames into out/store-assets/demo.gif.
//
// Run: npm run build && node scripts/demo-gif.mjs

import { chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const FIXTURES = resolve(ROOT, 'fixtures');
const OUT_GIF = resolve(ROOT, 'out', 'store-assets', 'demo.gif');

const PAGE_W = 820;
const PANEL_W = 400;
const VIEW_H = 640;

async function buildTestExtension() {
  const dir = await mkdtemp(join(tmpdir(), 'nf-demo-ext-'));
  await cp(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function startFixtureServer() {
  return new Promise((resolveOuter) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const pathname = url.pathname === '/' ? '/rolecast.html' : url.pathname;
      const filePath = resolve(FIXTURES, '.' + pathname);
      if (!filePath.startsWith(FIXTURES) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolveOuter({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function main() {
  if (!existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first');
  const extDir = await buildTestExtension();
  const userDataDir = await mkdtemp(join(tmpdir(), 'nf-demo-profile-'));
  const framesDir = await mkdtemp(join(tmpdir(), 'nf-demo-frames-'));
  const { server, origin } = await startFixtureServer();

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
  });

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const fixture = await context.newPage();
  await fixture.setViewportSize({ width: PAGE_W, height: VIEW_H });
  await fixture.goto(`${origin}/rolecast.html`);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: PANEL_W, height: VIEW_H });
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await fixture.bringToFront();

  const steps = [];
  const snap = async (caption, holdMs = 1000) => {
    const i = steps.length;
    const pagePath = join(framesDir, `s${i}-page.png`);
    const panelPath = join(framesDir, `s${i}-panel.png`);
    await fixture.screenshot({ path: pagePath });
    await panel.screenshot({ path: panelPath });
    steps.push({ page: pagePath, panel: panelPath, caption, holdMs });
  };

  // --- Step 1: the raw list + the Enable affordance ---
  await panel.waitForFunction(
    (o) => {
      const b = document.querySelector('button[data-action="enable-site"]');
      return b && b.textContent === `Enable on ${new URL(o).hostname}`;
    },
    origin,
    { timeout: 8000 },
  );
  await snap('A job board, unfiltered — open the panel and Enable the site');

  // --- Step 2: enable → auto-detected ---
  await panel.click('button[data-action="enable-site"]');
  await fixture.reload();
  await panel.waitForFunction(
    () => document.querySelector('[data-role="page-detected"]') !== null,
    undefined,
    { timeout: 8000 },
  );
  await fixture.bringToFront();
  await panel.waitForTimeout(400);
  await snap('The list is detected automatically — 10 items');

  // --- Step 3: type a phrase ---
  await panel.fill('input[data-input="phrase"]', 'Mandarin');
  await snap('Type what you DON’T want to see — e.g. “Mandarin”');

  // --- Step 4: add → items collapse ---
  await panel.click('button.phrase-add');
  await fixture.waitForFunction(() => document.querySelectorAll('.sliver').length >= 3, undefined, {
    timeout: 5000,
  });
  await fixture.bringToFront();
  await panel.waitForTimeout(300);
  await snap('Matching items collapse to a slim bar — nothing deleted', 1350);

  // --- Step 5: stack a second filter ---
  await panel.fill('input[data-input="phrase"]', 'unpaid');
  await panel.click('button.phrase-add');
  await fixture.waitForFunction(() => document.querySelectorAll('.sliver').length >= 4, undefined, {
    timeout: 5000,
  });
  await fixture.bringToFront();
  await panel.waitForTimeout(300);
  await snap('Stack filters — add “unpaid” to hide more');

  // --- Step 6: restore one ---
  const restoreBtn = panel.locator('button[data-action="restore"]').first();
  await restoreBtn.click();
  await fixture.bringToFront();
  await panel.waitForTimeout(400);
  await snap('Restore anything with one click — your filters stay saved', 1600);

  await writeFile(join(framesDir, 'steps.json'), JSON.stringify(steps, null, 2));

  await context.close();
  await new Promise((r) => server.close(() => r()));
  await rm(userDataDir, { recursive: true, force: true });
  await rm(extDir, { recursive: true, force: true });

  // --- Assemble the GIF with Pillow ---
  await mkdir(dirname(OUT_GIF), { recursive: true });
  const py = join(framesDir, 'assemble.py');
  await writeFile(py, ASSEMBLE_PY);
  execFileSync('python3', [py, framesDir, OUT_GIF, String(PAGE_W), String(PANEL_W), String(VIEW_H)], {
    stdio: 'inherit',
  });
  await rm(framesDir, { recursive: true, force: true });
  console.log(`\ndemo GIF → ${OUT_GIF}`);
}

const ASSEMBLE_PY = `
import json, sys
from PIL import Image, ImageDraw, ImageFont

frames_dir, out_gif, page_w, panel_w, view_h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
steps = json.load(open(frames_dir + '/steps.json'))

GAP, PAD, CAP_H = 16, 20, 64
EMERALD = (5, 150, 105)
EMERALD2 = (52, 211, 153)
DARK = (17, 24, 32)
content_w = page_w + GAP + panel_w
canvas_w = content_w + PAD * 2
canvas_h = CAP_H + PAD + view_h + PAD
SCALE = 0.78  # shrink final GIF for a sane file size

def font(sz, bold=False):
    paths = [
        '/System/Library/Fonts/Helvetica.ttc',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
    ]
    for p in paths:
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

cap_font = font(22)
brand_font = font(20)

def compose(step):
    page = Image.open(step['page']).convert('RGB')
    panel = Image.open(step['panel']).convert('RGB')
    # normalize heights
    page = page.crop((0, 0, page_w, min(view_h, page.height)))
    panel = panel.crop((0, 0, panel_w, min(view_h, panel.height)))
    cv = Image.new('RGB', (canvas_w, canvas_h), DARK)
    d = ImageDraw.Draw(cv)
    # caption bar (emerald)
    d.rectangle([0, 0, canvas_w, CAP_H], fill=EMERALD)
    d.rectangle([0, CAP_H - 3, canvas_w, CAP_H], fill=EMERALD2)
    cap = step['caption']
    tb = d.textbbox((0, 0), cap, font=cap_font)
    d.text((PAD, (CAP_H - (tb[3] - tb[1])) / 2 - tb[1]), cap, font=cap_font, fill=(255, 255, 255))
    brand = 'Negative Filter'
    bb = d.textbbox((0, 0), brand, font=brand_font)
    d.text((canvas_w - PAD - (bb[2] - bb[0]), (CAP_H - (bb[3] - bb[1])) / 2 - bb[1]), brand, font=brand_font, fill=(220, 252, 231))
    # page + panel
    y = CAP_H + PAD
    cv.paste(page, (PAD, y))
    cv.paste(panel, (PAD + page_w + GAP, y))
    # subtle frame around panel to read as the side panel
    d.rectangle([PAD + page_w + GAP - 1, y - 1, PAD + page_w + GAP + panel_w, y + panel.height], outline=(60, 70, 80))
    if SCALE != 1.0:
        cv = cv.resize((int(canvas_w * SCALE), int(canvas_h * SCALE)), Image.LANCZOS)
    return cv

frames, durations = [], []
imgs = [compose(s) for s in steps]
# quantize to a shared adaptive palette for smaller, cleaner output
for img, s in zip(imgs, steps):
    frames.append(img.quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE))
    durations.append(s['holdMs'])
# gentle crossfade-free hold; loop forever
frames[0].save(out_gif, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=2)
sz = __import__('os').path.getsize(out_gif)
print(f'frames={len(frames)} size={sz//1024} KB dims={frames[0].size}')
`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
