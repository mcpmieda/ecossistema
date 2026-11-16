import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export async function createLocalPortalHarnessV1(
  connectionString: string,
  servingEnabled = 'true',
) {
  const directory = mkdtempSync(join(tmpdir(), 'portal-harness-714-'));
  let runtime: Miniflare | undefined;
  const close = async () => {
    await runtime?.dispose();
    if (
      resolve(directory).startsWith(resolve(tmpdir())) &&
      basename(directory).startsWith('portal-harness-714-')
    )
      rmSync(directory, { recursive: true, force: true });
  };
  try {
    await promisify(execFile)(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--config',
        'tests/student-portal/load/wrangler.harness.jsonc',
        '--dry-run',
        '--outdir',
        directory,
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'portal-harness-714',
        modules: true,
        script: readFileSync(join(directory, 'harness-worker.js'), 'utf8'),
        compatibilityDate: '2026-09-11',
        compatibilityFlags: ['nodejs_compat'],
        ratelimits: {
          AUTH_GLOBAL: { namespace_id: '100714', simple: { limit: 600, period: 60 } },
          AUTH_SUBJECT: { namespace_id: '200714', simple: { limit: 30, period: 60 } },
        },
        bindings: { TEST_DATABASE_URL: connectionString, SERVING_ENABLED: servingEnabled },
      }),
    );
    return { runtime, close };
  } catch (error) {
    await close();
    throw error;
  }
}
