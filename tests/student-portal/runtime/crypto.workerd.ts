import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

let runtime: Miniflare | undefined;
const directory = mkdtempSync(join(tmpdir(), 'portal-crypto-proof-711-'));
beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--config',
      'tests/student-portal/crypto/wrangler.proof.jsonc',
      '--dry-run',
      '--outdir',
      directory,
    ],
    { windowsHide: true, timeout: 60_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'portal-crypto-proof',
      modules: true,
      script: readFileSync(join(directory, 'crypto-proof-worker.js'), 'utf8'),
      compatibilityDate: '2026-09-11',
      compatibilityFlags: ['nodejs_compat'],
    }),
  );
}, 90_000);
afterAll(async () => {
  await runtime?.dispose();
  if (
    resolve(directory).startsWith(resolve(tmpdir())) &&
    basename(directory).startsWith('portal-crypto-proof-711-')
  )
    rmSync(directory, { recursive: true, force: true });
});
it('executes the exact native scrypt/pepper/QR implementation in bundled workerd', async () => {
  const response = await runtime!.dispatchFetch('http://localhost/proof');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    valid: true,
    invalid: false,
    validQr: true,
    tokenBytes: 43,
    algorithm: 'scrypt-hmac-sha256-v1',
  });
});
