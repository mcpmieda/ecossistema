import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { adaptWorksheetConsumersV1 } from '../../tests/gradebook/fixtures/reader-candidate-v1.ts';

const root = process.cwd();
const gitExecutable =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git';
const baseline =
  process.argv.find((value) => value.startsWith('--baseline='))?.slice(11) ??
  '9f95387a4588653a2631288f929d94b4350bb5d6';
const cache = join(root, 'node_modules/.cache/gradebook-reader-v1');

async function saveBrowserReport(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error('Report too large');
  }
  const report = JSON.parse(body);
  if (
    report.reportVersion !== 1 ||
    report.libraryVersion !== '0.20.3' ||
    !Array.isArray(report.statistics)
  )
    throw new Error('Invalid report');
  const path = join(cache, 'browser-report.json');
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      path,
      equivalent: report.equivalence.filter((item) => item.equivalent === true).length,
      gaps: report.equivalence.filter((item) => item.equivalent !== true).length,
      environment: report.environment,
    }),
  );
}

function routeContent(url, html, library, bundles) {
  if (url === '/') return html;
  if (url === '/sheetjs.js') return library;
  return Object.hasOwn(bundles, url) ? bundles[url] : undefined;
}
await mkdir(cache, { recursive: true });
const loader = await readFile(
  join(root, 'src/features/gradebook/import/sheetjs-loader.ts'),
  'utf8',
);
const libraryUrl = loader.match(/const SHEETJS_SRC = '([^']+)'/u)?.[1];
const integrity = loader.match(/sha384-[A-Za-z0-9+/=]+/u)?.[0];
if (!libraryUrl || !integrity) throw new Error('Cannot read project library pin');
const libraryPath = join(cache, 'sheetjs-0.20.3.js');
let library;
try {
  library = await readFile(libraryPath);
} catch {
  const response = await fetch(libraryUrl);
  if (!response.ok) throw new Error(`Library download HTTP ${response.status}`);
  library = Buffer.from(await response.arrayBuffer());
  await writeFile(libraryPath, library);
}
if (`sha384-${createHash('sha384').update(library).digest('base64')}` !== integrity)
  throw new Error('SheetJS integrity mismatch');

const entry = `export { readWorkbookData, WORKBOOK_READ_OPTIONS } from './src/features/gradebook/import/workbook-reader';
export { createSourceFileManifest } from './src/features/gradebook/import/file-manifest';
export { createGradebookCanonicalImportRequestV9 } from './src/features/gradebook/import/canonical-import-v9';
export { collectGradebookImportDiagnosticsV1 } from './src/features/gradebook/import/import-diagnostics-v1';
export { WORKBOOK_READER_EQUIVALENCE_CASES_V1 } from './tests/gradebook/fixtures/workbook-reader-equivalence-v1';`;
const originalPaths = ['workbook-reader.ts', 'spreadsheet-recognizer.ts', 'master-relation-v9.ts'];
const original = new Map(
  originalPaths.map((name) => {
    const path = `src/features/gradebook/import/${name}`;
    return [
      resolve(root, path),
      execFileSync(gitExecutable, ['show', `${baseline}:${path}`], { encoding: 'utf8', cwd: root }),
    ];
  }),
);
const bundles = {};
for (const variant of ['S0', 'S1']) {
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: `HReader${variant}`,
    write: false,
    plugins:
      variant === 'S0'
        ? [
            {
              name: 'original-reader',
              setup(builder) {
                builder.onLoad(
                  { filter: /(?:workbook-reader|spreadsheet-recognizer|master-relation-v9)\.ts$/ },
                  async ({ path }) => {
                    const contents = original.get(path);
                    return contents
                      ? { contents, loader: 'ts', resolveDir: dirname(path) }
                      : undefined;
                  },
                );
              },
            },
          ]
        : [
            {
              name: 'candidate-reader-laboratory',
              setup(builder) {
                builder.onResolve({ filter: /^\.\/worksheet-cell-access-v1$/ }, () => ({
                  path: join(root, 'tests/gradebook/fixtures/worksheet-cell-access-v1.ts'),
                }));
                builder.onLoad(
                  { filter: /(?:spreadsheet-recognizer|master-relation-v9)\.ts$/ },
                  async ({ path }) => ({
                    contents: adaptWorksheetConsumersV1(await readFile(path, 'utf8'), path),
                    loader: 'ts',
                    resolveDir: dirname(path),
                  }),
                );
              },
            },
          ],
  });
  bundles[`/${variant.toLowerCase()}.js`] = result.outputFiles[0].contents;
}
const metadata = {
  baselineSha: baseline,
  candidateSha: execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeModified:
    execFileSync(gitExecutable, ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
  libraryUrl,
  integrity,
  modelSha256: Object.fromEntries(
    Object.entries(bundles).map(([path, bytes]) => [
      path,
      createHash('sha256').update(bytes).digest('hex'),
    ]),
  ),
  comparatorSha256: createHash('sha256')
    .update(await readFile(join(root, 'scripts/gradebook/reader-comparison-v1.mjs')))
    .digest('hex'),
};
for (const [path, bytes] of Object.entries(bundles))
  await writeFile(join(cache, path.slice(1)), bytes);
const run = await build({
  stdin: {
    contents: `import { compareWorkbookReadersV1 } from './scripts/gradebook/reader-comparison-v1.mjs';
const progress = document.getElementById('progress');
document.getElementById('run').onclick = async () => {
 document.getElementById('run').disabled = true;
 try {
  const report = { ...${JSON.stringify(metadata)}, ...await compareWorkbookReadersV1(globalThis.HReaderS0, globalThis.HReaderS1, globalThis.XLSX, value => { progress.textContent = value; }) };
  const result = await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  if (!result.ok) throw new Error('Report save failed');
  document.getElementById('report').textContent = JSON.stringify({ equivalent: report.equivalence.filter(item => item.equivalent === true).length, gaps: report.equivalence.filter(item => item.equivalent !== true).length, statistics: report.statistics }, null, 2);
  progress.textContent = 'Concluído';
 } catch (error) { progress.textContent = 'Falha: ' + error.message; }
};`,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  platform: 'browser',
  write: false,
});
bundles['/run.js'] = run.outputFiles[0].contents;
const html =
  '<!doctype html><meta charset="utf-8"><title>Adendo H — experimento sintético local</title><h1>Leitura local S0/S1/D1</h1><button id="run">Executar comparador</button><p id="progress">Pronto; sem acesso ao banco</p><pre id="report"></pre><script src="/sheetjs.js"></script><script src="/s0.js"></script><script src="/s1.js"></script><script src="/run.js"></script>';
const server = createServer(async (request, response) => {
  if (request.url === '/report' && request.method === 'POST') {
    try {
      await saveBrowserReport(request);
      response.writeHead(200).end('saved');
    } catch (error) {
      console.error(error);
      response.writeHead(400).end('invalid report');
    }
    return;
  }
  const content = routeContent(request.url, html, library, bundles);
  response.writeHead(content ? 200 : 404, {
    'content-type': request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript',
    'cache-control': 'no-store',
  });
  response.end(content ?? 'not found');
});
server.listen(0, '127.0.0.1', () =>
  console.log(`Local benchmark: http://127.0.0.1:${server.address().port}/`),
);
