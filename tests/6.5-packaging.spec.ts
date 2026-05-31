// 6.5 — Web Store packaging + privacy policy doc.
//
// Gate from tasks.md:
//   "built zip passes the Web Store manifest linter."
//
// The Chrome Web Store linter isn't available offline. We
// approximate by:
//   (a) running scripts/package.mjs end-to-end,
//   (b) unzipping the result and asserting the manifest passes the
//       checks the CWS linter is documented to apply (manifest_
//       version 3, required name/version/description, only known
//       permissions, no `host_permissions` baked in, all referenced
//       script paths exist in the zip).
//   (c) confirming PRIVACY.md exists at the repo root.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const KNOWN_PERMISSIONS = new Set([
  'sidePanel',
  'tabs',
  'scripting',
  'alarms',
  'storage',
  'activeTab',
]);

test.describe('6.5 — Web Store packaging', () => {
  test('package script builds a zip that passes manifest checks', async () => {
    // Run npm run package via execFileSync. Captures the script's
    // exit code; throws on non-zero.
    execFileSync('npm', ['run', 'package'], { cwd: ROOT, stdio: 'pipe' });

    // Find the zip.
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'dist', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const zipPath = resolve(ROOT, 'out', `sieve-${manifest['version']}.zip`);
    expect(existsSync(zipPath)).toBe(true);

    // Unzip into a tmpdir and validate the extracted manifest.
    const tmp = mkdtempSync(join(tmpdir(), 'nf-pkg-'));
    try {
      execFileSync('unzip', ['-q', zipPath, '-d', tmp]);
      const unzipped = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;

      // 1. manifest_version 3.
      expect(unzipped['manifest_version']).toBe(3);

      // 2. Required string fields.
      for (const k of ['name', 'version', 'description']) {
        expect(typeof unzipped[k]).toBe('string');
        expect((unzipped[k] as string).length).toBeGreaterThan(0);
      }

      // 3. Permissions are known.
      const perms = Array.isArray(unzipped['permissions'])
        ? (unzipped['permissions'] as string[])
        : [];
      for (const p of perms) {
        expect(KNOWN_PERMISSIONS.has(p)).toBe(true);
      }

      // 4. No host_permissions baked in (we use optional_host_permissions).
      expect('host_permissions' in unzipped).toBe(false);

      // 5. All referenced script paths exist in the zip.
      const refs = [
        (unzipped['background'] as Record<string, string>)?.['service_worker'],
        (unzipped['side_panel'] as Record<string, string>)?.['default_path'],
      ].filter((s): s is string => typeof s === 'string');
      for (const r of refs) {
        expect(existsSync(join(tmp, r))).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('PRIVACY.md exists at repo root and lists every storage key', async () => {
    const path = resolve(ROOT, 'PRIVACY.md');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    for (const key of [
      'nf:llm-settings',
      'nf:filters:',
      'nf:spend-ledger',
      'nf:deep-warning-dismissed',
      'nf:deep-queue',
    ]) {
      expect(body).toContain(key);
    }
  });
});
