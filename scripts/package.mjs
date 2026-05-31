#!/usr/bin/env node
// scripts/package.mjs — build the Web Store-ready zip.
//
// Bundles dist/ (built by esbuild) into out/sieve-<v>.zip.
// The version comes from manifest.json. Uses the system `zip`
// command — present on macOS / Linux dev machines.

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function main() {
  const distDir = resolve(ROOT, 'dist');
  if (!existsSync(distDir)) {
    throw new Error('dist/ missing — run `npm run build` first.');
  }
  const manifest = JSON.parse(await readFile(resolve(distDir, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  if (!version) throw new Error('manifest.json has no version');
  const outDir = resolve(ROOT, 'out');
  await mkdir(outDir, { recursive: true });
  const outZip = resolve(outDir, `sieve-${version}.zip`);
  // -X strips macOS .DS_Store + extra fields; -r recurses; -j is NOT
  // used so the dir structure is preserved.
  execFileSync('zip', ['-X', '-r', outZip, '.', '-i', '*'], {
    cwd: distDir,
    stdio: 'inherit',
  });
  console.log(`packaged → ${outZip}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
