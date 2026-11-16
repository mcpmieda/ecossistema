// @vitest-environment node
import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext, type Context } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  OUTPUT_SHA256,
  PATCH_VERSION,
  REFERENCE_COPY_SOURCE,
  UPSTREAM_SHA256,
  patchSheetJsReferenceV1,
} from '../../../scripts/gradebook/patch-sheetjs-reference-v1.mjs';
import { isGradebookImportPersistenceRequestV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { createGradebookCanonicalImportRequestV9 } from '../../../src/features/gradebook/import/canonical-import-v9';
import { createSourceFileManifest } from '../../../src/features/gradebook/import/file-manifest';
import { collectGradebookImportDiagnosticsV1 } from '../../../src/features/gradebook/import/import-diagnostics-v1';
import {
  readWorkbookData,
  WORKBOOK_READ_OPTIONS,
} from '../../../src/features/gradebook/import/workbook-reader';
import { writeRealWorkbookV1, type RealSheetJsV1 } from '../fixtures/sheetjs-real-v1';
import {
  WORKBOOK_READER_EQUIVALENCE_CASES_V1,
  syntheticResultV1,
  type WorkbookFixtureV1,
} from '../fixtures/workbook-reader-equivalence-v1';

type LibraryRealm = { context: Context; library: RealSheetJsV1 };
let upstreamBytes: Uint8Array;
let derivativeBytes: Uint8Array;
let original: LibraryRealm;
let derivative: LibraryRealm;

// Private functions are exposed only in this test VM. Neither distributed artifact changes.
function libraryRealm(bytes: Uint8Array): LibraryRealm {
  const anchor = 'function make_xlsx_lib(e){';
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (source.split(anchor).length !== 2) throw new Error('test-injection-anchor-mismatch');
  const injection =
    'e.__referenceTestsV1={Ar:Ar,Pa:Pa,La:La,Md:Md,copyRef:typeof escolaCopyRef1==="function"?escolaCopyRef1:Ar};';
  const context = createContext({
    ArrayBuffer,
    Uint8Array,
    Date,
    Buffer: NodeBuffer,
    TextEncoder,
    TextDecoder,
    XLSX: undefined as RealSheetJsV1 | undefined,
  });
  runInContext(source.replace(anchor, anchor + injection), context);
  const library = context.XLSX as RealSheetJsV1 | undefined;
  if (!library) throw new Error('missing-test-sheetjs');
  return { context, library };
}

/** Realm-native inputs exercise the plain-object fast path; clone preserves undefined and -0. */
function evaluate(realm: LibraryRealm, body: string): unknown {
  return structuredClone(
    runInContext(`(function(){var api=XLSX.__referenceTestsV1;${body}})()`, realm.context),
  );
}

function compare(body: string): unknown {
  const expected = evaluate(original, body);
  expect(evaluate(derivative, body)).toStrictEqual(expected);
  return expected;
}

function functionSource(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  if (start < 0 || end < 0) throw new Error('test-function-anchor-mismatch');
  return source.slice(start, end);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

beforeAll(async () => {
  upstreamBytes = await readFile('node_modules/xlsx/dist/xlsx.full.min.js');
  expect(createHash('sha256').update(upstreamBytes).digest('hex')).toBe(UPSTREAM_SHA256);
  derivativeBytes = patchSheetJsReferenceV1(NodeBuffer.from(upstreamBytes));
  original = libraryRealm(upstreamBytes);
  derivative = libraryRealm(derivativeBytes);
});

describe('reference-copy patch — fixed upstream and bounded derivative', () => {
  it('reproduces the reviewed rejected derivative in memory with only two changed anchors', () => {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(upstreamBytes);
    expect(source.split('function Pa(e,r,t){var a=Ar(e);')).toHaveLength(2);
    expect(source.split('e.version="0.20.3";')).toHaveLength(2);
    const expected =
      '/* eslint-disable */\n/*! Local derivative: escola-ref1; see PROVENANCE.md and LICENSE. */\n' +
      source
        .replace(
          'function Pa(e,r,t){var a=Ar(e);',
          `${REFERENCE_COPY_SOURCE}\nfunction Pa(e,r,t){var a=escolaCopyRef1(e);`,
        )
        .replace('e.version="0.20.3";', `e.version="${PATCH_VERSION}";`);
    expect(exactBytes(derivativeBytes, new TextEncoder().encode(expected))).toBe(true);
    expect(createHash('sha256').update(derivativeBytes).digest('hex')).toBe(OUTPUT_SHA256);
    expect(
      exactBytes(patchSheetJsReferenceV1(NodeBuffer.from(upstreamBytes)), derivativeBytes),
    ).toBe(true);
    expect(original.library.version).toBe('0.20.3');
    expect(derivative.library.version).toBe(PATCH_VERSION);
  });

  it('rejects modified input before patching and leaves global Ar, La, Ma and Md intact', () => {
    const tampered = NodeBuffer.from(upstreamBytes);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => patchSheetJsReferenceV1(tampered)).toThrow('sheetjs-upstream-integrity-mismatch');
    expect(() => patchSheetJsReferenceV1(NodeBuffer.from(derivativeBytes))).toThrow(
      'sheetjs-upstream-integrity-mismatch',
    );
    const source = new TextDecoder('utf-8', { fatal: true }).decode(upstreamBytes);
    const patched = new TextDecoder('utf-8', { fatal: true }).decode(derivativeBytes);
    for (const [name, nextName] of [
      ['Ar', 'Tr'],
      ['La', 'Ma'],
      ['Ma', 'Ua'],
      ['Md', 'Ud'],
    ]) {
      expect(functionSource(patched, name!, nextName!)).toBe(
        functionSource(source, name!, nextName!),
      );
    }
  });

  it.each([
    ['numeric flags in parser order', '{r:5,c:7,cRel:1,rRel:0}'],
    ['boolean flags', '{r:5,c:7,cRel:false,rRel:true}'],
    ['mixed flag types', '{r:5,c:7,cRel:true,rRel:0}'],
    ['negative zero in every field', '{r:-0,c:-0,cRel:-0,rRel:-0}'],
    ['finite fractions', '{r:0.1,c:2.5,cRel:1,rRel:false}'],
    ['frozen plain object', 'Object.freeze({r:5,c:7,cRel:1,rRel:0})'],
  ])(
    '%s preserves own keys, field types and clone independence without JSON',
    (_name, expression) => {
      const body = `
      var input=${expression}, stringify=JSON.stringify, calls=0;
      JSON.stringify=function(){++calls;return stringify.apply(this,arguments)};
      try {
        var copy=api.copyRef(input), keys=Object.keys(copy), independent=copy!==input;
        var result={copy:{...copy},keys:keys,independent:independent};
        copy.r=123; result.inputUnchanged=input.r!==123;
        result.calls=calls; return result;
      } finally {JSON.stringify=stringify;}`;
      const expected = evaluate(original, body) as Record<string, unknown>;
      const actual = evaluate(derivative, body) as Record<string, unknown>;
      expect(expected.calls).toBe(1);
      expect(actual.calls).toBe(0);
      expect({ ...actual, calls: expected.calls }).toStrictEqual(expected);
      expect(actual.independent).toBe(true);
      expect(actual.inputUnchanged).toBe(true);
    },
  );

  it.each([
    ['nested extras', '{r:1,c:2,cRel:1,rRel:0,extra:{array:[1,,undefined],missing:undefined}}'],
    ['reordered keys', '{rRel:1,cRel:0,c:2,r:1}'],
    ['missing flag', '{r:1,c:2,cRel:1}'],
    ['undefined field', '{r:1,c:undefined,cRel:1,rRel:0}'],
    ['wrong coordinate type', '{r:"1",c:2,cRel:1,rRel:0}'],
    ['wrong flag type', '{r:1,c:2,cRel:"1",rRel:0}'],
    ['nonfinite coordinate', '{r:Infinity,c:NaN,cRel:1,rRel:0}'],
    ['nonfinite flag', '{r:1,c:2,cRel:-Infinity,rRel:0}'],
    ['own toJSON', '{r:1,c:2,cRel:1,rRel:0,toJSON:function(){++effects;return {r:9,c:8}}}'],
    [
      'nonenumerable own toJSON',
      'Object.defineProperty({r:1,c:2,cRel:1,rRel:0},"toJSON",{value:function(){++effects;return {r:9,c:8}}})',
    ],
    [
      'getter',
      'Object.defineProperty({c:2,cRel:1,rRel:0},"r",{enumerable:true,get:function(){++effects;return 1}})',
    ],
    [
      'nonenumerable extra',
      'Object.defineProperty({r:1,c:2,cRel:1,rRel:0},"hidden",{value:{r:9}})',
    ],
    ['null prototype', 'Object.assign(Object.create(null),{r:1,c:2,cRel:1,rRel:0})'],
    [
      'inherited toJSON',
      'Object.assign(Object.create({toJSON:function(){++effects;return {r:9,c:8}}}),{r:1,c:2,cRel:1,rRel:0})',
    ],
    ['array', '[{r:1,c:2,cRel:1,rRel:0},null]'],
    ['date', 'new Date("2026-01-01T00:00:00Z")'],
    ['null', 'null'],
    ['primitive', '7'],
    ['undefined error', 'undefined'],
    ['bigint error', '{r:1n,c:2,cRel:1,rRel:0}'],
    ['circular error', '(function(){var e={r:1,c:2,cRel:1,rRel:0};e.extra=e;return e})()'],
  ])(
    '%s retains the upstream fallback value, error and observable side effects',
    (_name, expression) => {
      compare(`
      var effects=0, input=${expression}, stringify=JSON.stringify, calls=0;
      JSON.stringify=function(){++calls;return stringify.apply(this,arguments)};
      try {
        var outcome;
        try {outcome={value:api.copyRef(input)}}
        catch(error){outcome={error:{name:error.name,message:error.message}}}
        return {outcome:outcome,calls:calls,effects:effects};
      } finally {JSON.stringify=stringify;}`);
    },
  );

  it('ignores symbol-only data exactly as the upstream JSON clone does', () => {
    expect(
      compare(`
      var input={r:1,c:2,cRel:1,rRel:0};input[Symbol("synthetic")]=9;
      var result=api.copyRef(input);return {result:result,symbols:Object.getOwnPropertySymbols(result).length};
    `),
    ).toStrictEqual({ result: { r: 1, c: 2, cRel: 1, rRel: 0 }, symbols: 0 });
  });

  it('inherited Object.prototype toJSON getter executes only in upstream fallback', () => {
    expect(
      compare(`
      var effects=0;
      Object.defineProperty(Object.prototype,"toJSON",{configurable:true,get:function(){++effects;return undefined}});
      try {return {copy:api.copyRef({r:1,c:2,cRel:1,rRel:0}),effects:effects}}
      finally {delete Object.prototype.toJSON;}
    `),
    ).toStrictEqual({ copy: { r: 1, c: 2, cRel: 1, rRel: 0 }, effects: 1 });
  });

  it('inherited Object.prototype toJSON retains the original transformed value', () => {
    expect(
      compare(`
      var effects=0;
      Object.defineProperty(Object.prototype,"toJSON",{configurable:true,value:function(){++effects;return {r:9,c:8}}});
      try {return {copy:api.copyRef({r:1,c:2,cRel:1,rRel:0}),effects:effects}}
      finally {delete Object.prototype.toJSON;}
    `),
    ).toStrictEqual({ copy: { r: 9, c: 8 }, effects: 1 });
  });

  it.each(['r', 'c', 'cRel', 'rRel'])(
    'inherited %s setter cannot intercept copying own reference fields',
    (key) => {
      expect(
        compare(`
      var effects=0;
      Object.defineProperty(Object.prototype,"${key}",{configurable:true,set:function(){++effects},get:function(){++effects;return 999}});
      try {
        var input={r:1,c:2,cRel:1,rRel:0},copy=api.copyRef(input);
        return {copy:copy,keys:Object.keys(copy),effects:effects,input:input};
      } finally {delete Object.prototype["${key}"];}
    `),
      ).toStrictEqual({
        copy: { r: 1, c: 2, cRel: 1, rRel: 0 },
        keys: ['r', 'c', 'cRel', 'rRel'],
        effects: 0,
        input: { r: 1, c: 2, cRel: 1, rRel: 0 },
      });
    },
  );

  it.each(['r', 'c', 'cRel', 'rRel'])(
    'inherited non-writable %s cannot omit an own copied field',
    (key) => {
      expect(
        compare(`
      Object.defineProperty(Object.prototype,"${key}",{configurable:true,writable:false,value:999});
      try {
        var input={r:1,c:2,cRel:1,rRel:0},copy=api.copyRef(input);
        return {copy:copy,keys:Object.keys(copy),input:input};
      } finally {delete Object.prototype["${key}"];}
    `),
      ).toStrictEqual({
        copy: { r: 1, c: 2, cRel: 1, rRel: 0 },
        keys: ['r', 'c', 'cRel', 'rRel'],
        input: { r: 1, c: 2, cRel: 1, rRel: 0 },
      });
    },
  );

  it('documents the rejected candidate limitation: inherited scratch-array setter changes the clone', () => {
    const body = `
      var effects=0;
      Object.defineProperty(Array.prototype,"0",{configurable:true,set:function(){++effects},get:function(){return 999}});
      try {return {copy:api.copyRef({r:1,c:2,cRel:1,rRel:0}),effects:effects}}
      finally {delete Array.prototype["0"];}
    `;
    const expected = evaluate(original, body);
    const actual = evaluate(derivative, body);
    expect(expected).toStrictEqual({ copy: { r: 1, c: 2, cRel: 1, rRel: 0 }, effects: 0 });
    expect(actual).toStrictEqual({ copy: { r: 999, c: 2, cRel: 1, rRel: 0 }, effects: 1 });
    expect(actual).not.toStrictEqual(expected);
    // The rejected lab candidate is not a universally equivalent replacement for Ar.
  });

  it('without JSON retains legacy recursive copying and negative zero', () => {
    const expectedArray = [1, 2, 3];
    delete expectedArray[1];
    expect(
      compare(`
      var json=JSON;globalThis.JSON=undefined;
      try {
        var input={r:-0,c:2,cRel:1,rRel:0,extra:{absent:undefined,array:[1,,3]}};
        var copy=api.copyRef(input);copy.extra.array[0]=7;
        return {copy:copy,input:input,negativeZero:Object.is(copy.r,-0)};
      } finally {globalThis.JSON=json;}
    `),
    ).toMatchObject({ negativeZero: true, input: { extra: { array: expectedArray } } });
  });

  it.each([
    ['relative column only', '{r:5,c:7,cRel:1,rRel:0}', '{r:11,c:13}', '{biff:8}'],
    ['relative row only', '{r:5,c:7,cRel:0,rRel:1}', '{s:{r:11,c:13}}', '{biff:8}'],
    ['both absolute', '{r:5,c:7,cRel:0,rRel:0}', '{r:11,c:13}', '{biff:8}'],
    ['both relative', '{r:5,c:7,cRel:true,rRel:true}', '{r:11,c:13}', '{biff:8}'],
    ['BIFF8 wraps repeatedly', '{r:131071,c:511,cRel:1,rRel:1}', '{r:2,c:2}', '{biff:8}'],
    [
      'BIFF12 preserves expanded coordinates',
      '{r:131071,c:511,cRel:1,rRel:1}',
      '{r:2,c:2}',
      '{biff:12}',
    ],
    [
      'omitted options use original wraps',
      '{r:65535,c:255,cRel:1,rRel:1}',
      '{r:2,c:2}',
      'undefined',
    ],
    ['negative coordinates', '{r:-1,c:-2,cRel:1,rRel:1}', '{r:0,c:0}', '{biff:8}'],
    ['extra nested shape', '{r:5,c:7,cRel:1,rRel:0,extra:{keep:[1,2]}}', '{r:11,c:13}', '{biff:8}'],
  ])(
    'Pa: %s retains offsets and leaves its input untouched',
    (_name, expression, offset, options) => {
      compare(`
      var input=${expression}, before=api.Ar(input);
      var output=api.Pa(input,${offset},${options}), distinct=output!==input;
      output.r=99;if(output.extra)output.extra.keep[0]=99;
      return {input:input,before:before,output:output,distinct:distinct};
    `);
    },
  );

  it('La retains the full nested interval and creates independent endpoints', () => {
    expect(
      compare(`
      var input={s:{r:1,c:2,cRel:1,rRel:0},e:{r:3,c:4,cRel:0,rRel:1},extra:{keep:[1,2]}};
      var output=api.La(input,{s:{r:10,c:20}}, {biff:8});
      var shifted=api.Ar(output),independent=output!==input&&output.s!==input.s&&output.e!==input.e;
      output.s.c=99;output.extra.keep[0]=99;
      return {shifted:shifted,input:input,independent:independent};
    `),
    ).toMatchObject({
      shifted: { s: { r: 1, c: 22, cRel: 1, rRel: 0 }, e: { r: 13, c: 4, cRel: 0, rRel: 1 } },
      input: { extra: { keep: [1, 2] } },
      independent: true,
    });
  });

  it.each([
    ['PtgRef', '[["PtgRef",[0,{r:4,c:2,cRel:1,rRel:0}]]]', 'C$5'],
    ['PtgRefN', '[["PtgRefN",[0,{r:4,c:2,cRel:0,rRel:1}]]]', '$C15'],
    ['PtgRef3d', '[["PtgRef3d",[0,0,{r:4,c:2,cRel:0,rRel:1}]]]', "'SYNTHETIC SOURCE'!$C5"],
    [
      'PtgArea',
      '[["PtgArea",[0,{s:{r:1,c:2,cRel:1,rRel:0},e:{r:3,c:4,cRel:0,rRel:1}}]]]',
      'C$2:$E4',
    ],
    [
      'PtgAreaN',
      '[["PtgAreaN",[0,{s:{r:1,c:2,cRel:1,rRel:0},e:{r:3,c:4,cRel:0,rRel:1}}]]]',
      'W$2:$E14',
    ],
    [
      'SUM interval',
      '[["PtgAreaN",[0,{s:{r:1,c:2,cRel:1,rRel:0},e:{r:3,c:4,cRel:0,rRel:1}}]],["PtgAttrSum",0]]',
      'SUM(W$2:$E14)',
    ],
  ])('Md reconstructs %s using the same references and formula text', (_name, tokens, expected) => {
    expect(
      compare(`
      var tokens=[${tokens},[]],before=api.Ar(tokens);
      var formula=api.Md(tokens,null,{r:10,c:20},{SheetNames:["SYNTHETIC SOURCE"]},{biff:12});
      return {formula:formula,tokens:tokens,before:before};
    `),
    ).toMatchObject({ formula: expected });
  });
});

const formats = ['xlsx', 'xls', 'xlsb'] as const;
const fixedNow = () => new Date('2026-10-02T12:00:00Z');

function failure(error: unknown) {
  if (typeof error === 'object' && error !== null && 'name' in error && 'message' in error) {
    return { name: String(error.name), message: String(error.message) };
  }
  return { name: typeof error, message: String(error) };
}

async function readerOutput(realm: LibraryRealm, file: File, bytes: ArrayBuffer) {
  const manifest = await createSourceFileManifest(file, bytes, realm.library.version, {
    now: fixedNow,
    digestSha256: async (data) =>
      new Uint8Array(createHash('sha256').update(new Uint8Array(data)).digest()).buffer,
  });
  let summary: ReturnType<typeof readWorkbookData>;
  try {
    summary = structuredClone(
      readWorkbookData(file, bytes, realm.library, manifest, undefined, true),
    );
  } catch (error) {
    return { kind: 'reader-error' as const, error: failure(error) };
  }
  expect(summary.parserVersion).toBe(realm.library.version);
  const result = syntheticResultV1(manifest, summary);
  const diagnostics = collectGradebookImportDiagnosticsV1(result);
  // Only the intentional technical parser identifier differs between these libraries.
  const comparableSummary = { ...summary, parserVersion: 'controlled-reference-patch-comparison' };
  let request: ReturnType<typeof createGradebookCanonicalImportRequestV9>;
  try {
    request = createGradebookCanonicalImportRequestV9(result);
  } catch (error) {
    return {
      kind: 'canonical-error' as const,
      summary: comparableSummary,
      diagnostics,
      error: failure(error),
    };
  }
  expect(isGradebookImportPersistenceRequestV9(request)).toBe(true);
  const suffix = ':canonical-v9:observed-blanks-v1:decimal-grades-v1:definition-snapshot-v1';
  expect(request.manifest.parserVersion).toBe(realm.library.version + suffix);
  return {
    kind: 'request' as const,
    summary: comparableSummary,
    diagnostics,
    request: {
      ...request,
      manifest: {
        ...request.manifest,
        parserVersion: 'controlled-reference-patch-comparison' + suffix,
      },
    },
  };
}

function formulaCount(workbook: WorkbookFixtureV1): number {
  return Object.values(workbook.Sheets).reduce(
    (total, sheet) =>
      total +
      Object.entries(sheet).filter(
        ([address, cell]) =>
          !address.startsWith('!') &&
          typeof cell === 'object' &&
          cell !== null &&
          'f' in cell &&
          typeof cell.f === 'string',
      ).length,
    0,
  );
}

describe('reference-copy patch — real fixed codecs, synthetic files, no benchmark', () => {
  for (const format of formats) {
    it.each(WORKBOOK_READER_EQUIVALENCE_CASES_V1.filter((item) => item.id !== 'empty-workbook'))(
      `${format}: $id retains complete parsed cells, summary, diagnostics, canonical output and errors`,
      async (testCase) => {
        // Produce bytes once with the original codec; both readers receive the same file.
        const beforeFixture = structuredClone(testCase.workbook);
        const bytes = writeRealWorkbookV1(original.library, testCase.workbook, format);
        const beforeBytes = new Uint8Array(bytes).slice();
        const file = new File([bytes], `Notas - Docente Fictício - 2026-${testCase.id}.${format}`, {
          lastModified: Date.UTC(2026, 0, 1),
        });
        const parsed = structuredClone(original.library.read(bytes, WORKBOOK_READ_OPTIONS));
        expect(
          structuredClone(derivative.library.read(bytes, WORKBOOK_READ_OPTIONS)),
        ).toStrictEqual(parsed);
        const expected = await readerOutput(original, file, bytes);
        expect(await readerOutput(derivative, file, bytes)).toStrictEqual(expected);
        if (testCase.id === 'teacher' || testCase.id === 'relation') {
          expect(expected.kind).toBe('request');
          if (expected.kind !== 'request') throw new Error('valid-codec-fixture-rejected');
          if (expected.request.operation === 'persist-notas') {
            expect(expected.request.ofertas).toHaveLength(1);
            expect(expected.summary.gradeSheets.map((sheet) => sheet.name)).toStrictEqual([
              '6AVG',
              '6A1º',
              '6A2º',
              '6A3º',
              '6AREC',
            ]);
          } else {
            expect(expected.request.turmas).toHaveLength(3);
            expect(expected.request.turmas.at(-1)?.alunos.at(-1)?.[0]).toBe(46);
          }
        }
        expect(exactBytes(new Uint8Array(bytes), beforeBytes)).toBe(true);
        expect(testCase.workbook).toStrictEqual(beforeFixture);
      },
    );

    it(`${format}: empty writer refusal remains explicit rather than codec coverage`, () => {
      const empty = WORKBOOK_READER_EQUIVALENCE_CASES_V1.find(
        (item) => item.id === 'empty-workbook',
      )!;
      expect(() => writeRealWorkbookV1(original.library, empty.workbook, format)).toThrow();
      expect(() => writeRealWorkbookV1(derivative.library, empty.workbook, format)).toThrow();
    });

    it(`${format}: binary writer formula limitations are explicit`, () => {
      const source = WORKBOOK_READER_EQUIVALENCE_CASES_V1.find(
        (item) => item.id === 'teacher',
      )!.workbook;
      const bytes = writeRealWorkbookV1(original.library, source, format);
      const parsed = original.library.read(bytes, WORKBOOK_READ_OPTIONS);
      const sourceFormulas = formulaCount(source);
      const parsedFormulas = formulaCount(parsed as unknown as WorkbookFixtureV1);
      expect(sourceFormulas).toBeGreaterThan(0);
      if (format === 'xlsx') expect(parsedFormulas).toBe(sourceFormulas);
      else expect(parsedFormulas).toBeLessThan(sourceFormulas);
      // Equality of generated bytes does not prove binary writer preserves unsupported formulas.
      expect(structuredClone(derivative.library.read(bytes, WORKBOOK_READ_OPTIONS))).toStrictEqual(
        structuredClone(parsed),
      );
    });

    it(`${format}: mixed reference formula text exposes the binary writer gap explicitly`, () => {
      const formulas = ['A1', '$A1', 'A$1', '$A$1', 'A1:$B$2', "'SYNTHETIC SOURCE'!$A1"];
      const workbook: WorkbookFixtureV1 = {
        SheetNames: ['REFERENCES', 'SYNTHETIC SOURCE'],
        Sheets: {
          REFERENCES: {
            '!ref': 'A1:G2',
            A1: { t: 'n', v: 2 },
            ...Object.fromEntries(
              formulas.map((f, index) => [
                `${String.fromCharCode(66 + index)}2`,
                { t: 'n', v: 2, f },
              ]),
            ),
          },
          'SYNTHETIC SOURCE': { '!ref': 'A1:A1', A1: { t: 'n', v: 2 } },
        },
      };
      const bytes = writeRealWorkbookV1(original.library, workbook, format);
      const parsed = original.library.read(bytes, WORKBOOK_READ_OPTIONS);
      expect(structuredClone(derivative.library.read(bytes, WORKBOOK_READ_OPTIONS))).toStrictEqual(
        structuredClone(parsed),
      );
      const outputFormulas = formulas.map(
        (_formula, index) =>
          (
            parsed.Sheets.REFERENCES?.[`${String.fromCharCode(66 + index)}2`] as
              { f?: string } | undefined
          )?.f,
      );
      if (format !== 'xlsx')
        expect(outputFormulas.every((formula) => formula === undefined)).toBe(true);
      else expect(outputFormulas).toStrictEqual(formulas);
    });
  }
});
