/** Local synthetic experiment. Timing assertions deliberately stay out of unit tests. */
export function equalValue(left, right, path = '$') {
  if (Object.is(left, right)) return;
  if (typeof left !== typeof right || left === null || right === null) throw new Error(path);
  if (typeof left !== 'object') throw new Error(path);
  if (Object.prototype.toString.call(left) !== Object.prototype.toString.call(right))
    throw new Error(path);
  if (Object.prototype.toString.call(left) === '[object Date]') {
    if (!Object.is(left.getTime(), right.getTime())) throw new Error(path);
    return;
  }
  if (Array.isArray(left) !== Array.isArray(right)) throw new Error(path);
  const leftKeys = Object.keys(left).sort(comparePropertyNames);
  const rightKeys = Object.keys(right).sort(comparePropertyNames);
  if (leftKeys.length !== rightKeys.length) throw new Error(`${path}: keys`);
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) throw new Error(`${path}: key`);
    equalValue(left[leftKeys[index]], right[rightKeys[index]], `${path}.${leftKeys[index]}`);
  }
  if (Array.isArray(left) && left.length !== right.length) throw new Error(`${path}: length`);
}

function comparePropertyNames(left, right) {
  const comparison = left.localeCompare(right);
  if (comparison !== 0) return comparison;
  // Locale-equivalent strings still denote distinct object properties.
  if (left < right) return -1;
  return Number(left > right);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function measure(reader, xlsx, variant, item, manifest, bytes) {
  let timing;
  let summary;
  let readError;
  let canonicalError;
  let request;
  let diagnostics;
  const library = {
    version: xlsx.version,
    utils: xlsx.utils,
    read: (data, options) =>
      xlsx.read(data, variant === 'D1' ? { ...options, dense: true } : options),
  };
  const start = performance.now();
  try {
    summary = reader.readWorkbookData(
      item.file,
      bytes,
      library,
      manifest,
      (value) => {
        timing = value;
      },
      true,
    );
  } catch (error) {
    readError = errorText(error);
  }
  const readMs = performance.now() - start;
  const canonicalStart = performance.now();
  if (summary) {
    const result = { id: 'synthetic-file', manifest, summary };
    diagnostics = reader.collectGradebookImportDiagnosticsV1(result);
    try {
      request = reader.createGradebookCanonicalImportRequestV9(result);
    } catch (error) {
      canonicalError = errorText(error);
    }
  }
  const canonicalMs = performance.now() - canonicalStart;
  return {
    output: { summary, diagnostics, request, readError, canonicalError },
    costs: {
      readMs,
      canonicalMs,
      fullMs: readMs + canonicalMs,
      xlsxReadMs: timing?.xlsxReadMs ?? 0,
      relationMs: timing?.masterRelationRecognitionMs ?? 0,
      recognizeMs: timing?.recognizeWorkbookMs ?? 0,
      adaptationMs: 0,
    },
  };
}

export function describeWorkbook(workbook) {
  return {
    sheets: workbook.SheetNames.length,
    ranges: workbook.SheetNames.map((name) => workbook.Sheets[name]['!ref'] ?? null),
    cells: workbook.SheetNames.reduce(
      (count, name) =>
        count + Object.keys(workbook.Sheets[name]).filter((key) => !key.startsWith('!')).length,
      0,
    ),
    formulas: workbook.SheetNames.reduce(
      (count, name) =>
        count +
        Object.values(workbook.Sheets[name]).filter(
          (cell) => cell && typeof cell === 'object' && cell.f,
        ).length,
      0,
    ),
  };
}

function writableCellType(value) {
  if (value instanceof Date) return 'd';
  if (typeof value === 'boolean') return 'b';
  if (typeof value === 'string') return 's';
  return 'n';
}

function writableWorkbook(workbook) {
  const copy = structuredClone(workbook);
  for (const sheet of Object.values(copy.Sheets))
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!') || !cell || typeof cell !== 'object' || cell.t) continue;
      cell.t = writableCellType(cell.v);
    }
  return copy;
}

function largerGradeSheet(template, classCode) {
  const sheet = structuredClone(template);
  const rowCells = Object.entries(sheet).filter(([address]) => /^[A-Z]+5$/u.test(address));
  for (const key of Object.keys(sheet)) {
    const address = /^[A-Z]+(\d+)$/u.exec(key);
    if (address && Number(address[1]) >= 5) delete sheet[key];
  }
  for (let row = 5; row <= 16; row += 1) {
    for (const [address, cell] of rowCells)
      sheet[address.replace(/5$/u, String(row))] = structuredClone(cell);
    sheet[`G${row}`] = { t: 's', v: 'NOVATO' };
    sheet[`J${row}`] = { t: 'n', v: row - 4 };
    sheet[`K${row}`] = { t: 's', v: `SYNTHETIC STUDENT ${classCode}-${row - 4}` };
  }
  sheet.J1 = { t: 'n', v: 12 };
  sheet.K3 = { t: 's', v: classCode };
  sheet['!ref'] = 'A1:AN50';
  return sheet;
}

export function largerTeacher(workbook, year) {
  const output = { SheetNames: [], Sheets: {} };
  const templateNames = workbook.SheetNames.filter((name) => /^6A(?:[123]º|REC)$/u.test(name));
  for (let index = 0; index < 9; index += 1) {
    const classCode = `6${String.fromCodePoint(65 + index)}`;
    for (const templateName of templateNames) {
      const name = templateName.replace('6A', classCode);
      output.SheetNames.push(name);
      output.Sheets[name] = largerGradeSheet(workbook.Sheets[templateName], classCode);
    }
  }
  output.SheetNames.push('CONFIGURAÇÃO');
  output.Sheets.CONFIGURAÇÃO = structuredClone(workbook.Sheets.CONFIGURAÇÃO);
  output.Sheets.CONFIGURAÇÃO.C2 = { t: 'n', v: year };
  return output;
}

export function writeFixture(xlsx, source, format) {
  try {
    return {
      data: xlsx.write(writableWorkbook(source.workbook), {
        type: 'array',
        bookType: format,
        compression: true,
      }),
    };
  } catch (error) {
    if (source.id !== 'empty-workbook')
      throw new Error(`Fixture write failed: ${source.id}/${format}: ${errorText(error)}`, {
        cause: error,
      });
    return { gap: { id: source.id, format, equivalent: null, gap: errorText(error) } };
  }
}

export function codecPart(xlsx, data, format) {
  const bytes = new Uint8Array(data);
  const signature = format === 'xls' ? [0xd0, 0xcf] : [0x50, 0x4b];
  if (bytes[0] !== signature[0] || bytes[1] !== signature[1])
    throw new Error(`Wrong codec container: ${format}`);
  const parts = xlsx.CFB.read(bytes, { type: 'array' }).FullPaths;
  const expected = {
    xls: /\/(?:Workbook|Book)$/u,
    xlsb: /\/xl\/workbook\.bin$/u,
    xlsx: /\/xl\/workbook\.xml$/u,
  }[format];
  const part = parts.find((value) => expected.test(value));
  if (!part) throw new Error(`Wrong workbook part: ${format}`);
  return part;
}

async function prepareCorpus(baseline, candidate, xlsx) {
  const fixedNow = () => new Date('2026-10-02T12:00:00.000Z');
  const variants = ['S0', 'S1', 'D1'];
  const entries = [];
  const equivalence = [];
  const teacherSource = candidate.WORKBOOK_READER_EQUIVALENCE_CASES_V1.find(
    (item) => item.id === 'teacher',
  );
  const corpus = [
    ...candidate.WORKBOOK_READER_EQUIVALENCE_CASES_V1,
    { id: 'benchmark-9offers', workbook: largerTeacher(teacherSource.workbook, 2026) },
    { id: 'benchmark-9offers-2025', workbook: largerTeacher(teacherSource.workbook, 2025) },
  ];
  for (const source of corpus) {
    for (const format of ['xlsx', 'xlsb', 'xls']) {
      const { data, gap } = writeFixture(xlsx, source, format);
      if (gap) {
        equivalence.push(gap);
        continue;
      }
      const part = codecPart(xlsx, data, format);
      const file = new File([data], `${source.id}.${format}`, {
        lastModified: Date.parse('2026-10-02T12:00:00Z'),
      });
      const manifest = await candidate.createSourceFileManifest(file, data, xlsx.version, {
        now: fixedNow,
      });
      const item = { id: source.id, format, file, data, manifest };
      const before = new Uint8Array(data).slice();
      const original = measure(baseline, xlsx, 'S0', item, manifest, data).output;
      for (const variant of ['S1', 'D1']) {
        const measured = measure(candidate, xlsx, variant, item, manifest, data);
        equalValue(original, measured.output, `${source.id}/${format}/${variant}`);
      }
      equalValue(before, new Uint8Array(data), `${source.id}/${format}: input mutation`);
      const parsed = xlsx.read(data, candidate.WORKBOOK_READ_OPTIONS);
      equivalence.push({
        id: source.id,
        format,
        bytes: data.byteLength,
        codecPart: part,
        source: describeWorkbook(source.workbook),
        parsed: describeWorkbook(parsed),
        outcome: readOutcome(original),
        operation: original.request?.operation ?? null,
        diagnostics: original.diagnostics?.length ?? 0,
        variants: variants.slice(),
        equivalent: true,
      });
      entries.push(item);
    }
  }
  return { entries, equivalence };
}

function readOutcome(output) {
  if (output.readError) return 'read-error';
  if (output.canonicalError) return 'canonical-error';
  return 'request';
}

function createScenarios(entries) {
  const scenarios = [];
  for (const format of ['xlsx', 'xlsb', 'xls']) {
    const teacher = entries.find(
      (item) => item.format === format && item.id === 'benchmark-9offers',
    );
    if (!teacher) throw new Error('Missing teacher corpus');
    scenarios.push({ id: `single-${format}`, items: [teacher] });
  }
  const teachers = entries.filter((item) => item.id.startsWith('benchmark-9offers'));
  const relations = entries.filter((item) => item.id === 'relation');
  for (const count of [18, 50]) {
    const items = Array.from({ length: count }, (_, index) => teachers[index % teachers.length]);
    items[count - 1] = relations[count % relations.length];
    scenarios.push({ id: `batch-${count}`, items });
  }
  return scenarios;
}

async function collectSamples(baseline, candidate, xlsx, scenarios, onProgress) {
  // Parsing fixed bytes and full file/hash flow are reported in distinct cuts.
  const variants = ['S0', 'S1', 'D1'];
  const samples = [];
  for (const scenario of scenarios) {
    for (const cut of ['fixed-bytes', 'file-and-hash']) {
      for (let round = 0; round <= 5; round += 1) {
        const order = round % 2 ? [...variants].reverse() : variants;
        for (const variant of order) {
          onProgress(`${scenario.id}/${cut}/${round}/${variant}`);
          samples.push(
            await measureScenario(baseline, candidate, xlsx, scenario, cut, round, variant),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
  }
  return samples;
}

async function measureScenario(baseline, candidate, xlsx, scenario, cut, round, variant) {
  const reader = variant === 'S0' ? baseline : candidate;
  const start = performance.now();
  const costs = {
    xlsxReadMs: 0,
    adaptationMs: 0,
    relationMs: 0,
    recognizeMs: 0,
    readMs: 0,
    canonicalMs: 0,
    fullMs: 0,
  };
  for (const item of scenario.items) {
    const bytes = cut === 'fixed-bytes' ? item.data : await item.file.arrayBuffer();
    const manifest =
      cut === 'fixed-bytes'
        ? item.manifest
        : await candidate.createSourceFileManifest(item.file, bytes, xlsx.version, {
            now: () => new Date('2026-10-02T12:00:00.000Z'),
          });
    const result = measure(reader, xlsx, variant, item, manifest, bytes);
    if (result.output.readError || result.output.canonicalError)
      throw new Error(
        `Invalid measured fixture: ${item.id}/${item.format}/${variant}: ${result.output.readError ?? result.output.canonicalError}`,
      );
    for (const key of Object.keys(costs)) costs[key] += result.costs[key];
  }
  return {
    scenario: scenario.id,
    cut,
    variant,
    round,
    phase: round === 0 ? 'first-timed-after-preflight' : 'warm',
    files: scenario.items.length,
    bytes: scenario.items.reduce((sum, item) => sum + item.data.byteLength, 0),
    elapsedMs: performance.now() - start,
    ...costs,
  };
}

function summarizeSamples(scenarios, samples) {
  const variants = ['S0', 'S1', 'D1'];
  const statistics = [];
  for (const scenario of scenarios)
    for (const cut of ['fixed-bytes', 'file-and-hash'])
      for (const variant of variants) {
        const values = samples
          .filter(
            (sample) =>
              sample.scenario === scenario.id &&
              sample.cut === cut &&
              sample.variant === variant &&
              sample.phase === 'warm',
          )
          .map((sample) => sample.elapsedMs)
          .sort((a, b) => a - b);
        statistics.push({
          scenario: scenario.id,
          cut,
          variant,
          minMs: values[0],
          medianMs: values[2],
          maxMs: values[4],
        });
      }
  for (const stats of statistics) {
    const initial = statistics.find(
      (value) =>
        value.scenario === stats.scenario && value.cut === stats.cut && value.variant === 'S0',
    );
    stats.differenceMs = stats.medianMs - initial.medianMs;
    stats.differencePercent = initial.medianMs
      ? (stats.differenceMs / initial.medianMs) * 100
      : null;
  }
  return statistics;
}

export async function compareWorkbookReadersV1(baseline, candidate, xlsx, onProgress = () => {}) {
  if (xlsx.version !== '0.20.3') throw new Error('Unexpected SheetJS version');
  const { entries, equivalence } = await prepareCorpus(baseline, candidate, xlsx);
  const scenarios = createScenarios(entries);
  const samples = await collectSamples(baseline, candidate, xlsx, scenarios, onProgress);
  return {
    reportVersion: 1,
    libraryVersion: xlsx.version,
    recordedAt: new Date().toISOString(),
    environment: typeof navigator === 'undefined' ? `Node ${process.version}` : navigator.userAgent,
    heap: 'not measured',
    adaptation: 'direct access; no workbook conversion or copy',
    limitations: [
      'Synthetic corpus; no inference about the original 20874.7 ms',
      'Writer formula/cache fidelity reported by format; object fixtures cover unavailable/blank cache',
      'Sequential reader/hash flow; queue/auth/Portal are separate regression tests',
    ],
    equivalence,
    samples,
    statistics: summarizeSamples(scenarios, samples),
  };
}
