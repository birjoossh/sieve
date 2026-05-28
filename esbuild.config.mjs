// esbuild.config.mjs — one bundle per extension surface.
//
// Three entry points, all dumped flat into dist/ so manifest.json paths stay
// stable: background.js (service worker), content.js (content script),
// panel.js (side panel). Static assets — manifest.json, panel.html, panel.css —
// are copied from extension/ into dist/ alongside the JS.
//
// MV3 service workers run as ES modules (manifest "type": "module") so we keep
// `format: 'esm'` for the background; content scripts run classic so we use
// `format: 'iife'` there; the panel is loaded by a <script> tag in panel.html
// and is also classic.

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, 'extension');
const OUT = resolve(__dirname, 'dist');
const TESTS = resolve(__dirname, 'tests');

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  target: ['chrome120'],
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

/** One esbuild config per entry. */
const entries = [
  {
    name: 'background',
    options: {
      ...common,
      entryPoints: [resolve(SRC, 'background/sw.ts')],
      outfile: resolve(OUT, 'background.js'),
      format: 'esm',
      platform: 'browser',
    },
  },
  {
    name: 'content',
    options: {
      ...common,
      entryPoints: [resolve(SRC, 'content/index.ts')],
      outfile: resolve(OUT, 'content.js'),
      format: 'iife',
      platform: 'browser',
    },
  },
  {
    name: 'panel',
    options: {
      ...common,
      entryPoints: [resolve(SRC, 'panel/panel.ts')],
      outfile: resolve(OUT, 'panel.js'),
      format: 'iife',
      platform: 'browser',
    },
  },
  // Test-only bundle (dist/testbed/runtime.js). Exposes content-script
  // internals on window.__nf so Playwright specs can drive them without a
  // full extension load. Not referenced by manifest.json — only by tests.
  {
    name: 'testbed',
    options: {
      ...common,
      entryPoints: [resolve(TESTS, 'testbed/runtime.ts')],
      outfile: resolve(OUT, 'testbed/runtime.js'),
      format: 'iife',
      platform: 'browser',
    },
  },
];

async function copyStaticAssets() {
  // Manifest at dist root (Chrome looks for it there).
  await cp(resolve(SRC, 'manifest.json'), resolve(OUT, 'manifest.json'));
  // Panel HTML + CSS — referenced by the manifest's side_panel entry (added in 0.2).
  await cp(resolve(SRC, 'panel/panel.html'), resolve(OUT, 'panel.html'));
  if (existsSync(resolve(SRC, 'panel/panel.css'))) {
    await cp(resolve(SRC, 'panel/panel.css'), resolve(OUT, 'panel.css'));
  }
}

async function run() {
  // Fresh dist so deletes don't linger.
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  if (watch) {
    const ctxs = await Promise.all(entries.map(({ options }) => context(options)));
    await Promise.all(ctxs.map((c) => c.watch()));
    await copyStaticAssets();
    console.log('esbuild: watching…');
    return;
  }

  await Promise.all(entries.map(({ options }) => build(options)));
  await copyStaticAssets();
  console.log(`esbuild: built ${entries.length} bundles → ${OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
