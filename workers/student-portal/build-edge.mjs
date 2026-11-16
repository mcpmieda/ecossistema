import { copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const output = 'node_modules/.cache/student-portal-edge';
const cache = await realpath('node_modules/.cache');
if (resolve(output) !== `${cache}${sep}student-portal-edge`) throw new Error('Unexpected build output path');
await rm(resolve(output), { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp('node_modules/.cache/student-portal-ui', output, { recursive: true });
execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'pages',
    'functions',
    'build',
    'workers/student-portal/edge',
    '--outdir',
    `${output}-bundle`,
    '--build-output-directory',
    'workers/student-portal/edge-assets',
    '--compatibility-date',
    '2026-09-11',
    '--compatibility-flags',
    'nodejs_compat',
  ],
  { stdio: 'inherit' },
);
const config = JSON.parse(await readFile('wrangler.student-portal-edge.jsonc', 'utf8'));
await copyFile(`${output}-bundle/index.js`, `${output}/_worker.js`);
delete config.$schema;
await writeFile(`${output}/wrangler.jsonc`, `${JSON.stringify(config, null, 2)}\n`);
// The hashed files under /assets come straight from Pages, without a Function invocation and a log
// line each; the page, the API and every other path stay on the Function, which
// keeps the origin rules and answers 404 for anything else (wrangler.jsonc included). _headers
// gives the assets the same headers the Function set, and 404.html keeps a missing asset a 404
// (without it Pages would answer the page itself, with 200).
await writeFile(
  `${output}/_routes.json`,
  JSON.stringify({ version: 1, include: ['/*'], exclude: ['/assets/*'] }),
);
const ASSET_CSP_V1 = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; font-src 'self'; worker-src 'self' blob:";
await writeFile(`${output}/_headers`, [
  '/assets/*',
  `  Content-Security-Policy: ${ASSET_CSP_V1}`,
  '  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  '  Referrer-Policy: no-referrer',
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
].join('\n'));
await writeFile(`${output}/404.html`, '<!doctype html><meta charset="utf-8"><title>404</title>\n');
