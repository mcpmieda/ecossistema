// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  readBiff12RecordsV1,
  writeBiff12RecordsV1,
  type Biff12RecordV1,
} from '../../../server/gradebook/onedrive-sync/links/biff12-records-v1';
import {
  forceXlsbRecalcOnOpenV1,
  forceXlsxRecalcOnOpenV1,
  readXlsbLinkCacheV1,
  readXlsxLinkCacheV1,
  rewriteXlsbLinkCacheV1,
  rewriteXlsxLinkCacheV1,
  UnsupportedLinkValueError,
  type LinkValueV1,
} from '../../../server/gradebook/onedrive-sync/links/external-link-cache-v1';
import { graphReplaceWorkbookV1 } from '../../../server/gradebook/onedrive-sync/links/graph-links-v1';
import {
  changedSourcesV1,
  finishLinkRefreshV1,
  linkFilesToStartV1,
  linkTargetOfV1,
  newLinkFileV1,
  requestLinkRefreshV1,
  startLinkRefreshV1,
  LINK_SOURCE_SETTLE_MS_V1,
  type LinkFileV1,
} from '../../../server/gradebook/onedrive-sync/links/link-rules-v1';
import {
  readDestinationLinksV1,
  refreshDestinationLinksV1,
  resolveLinkSourceV1,
  type LinkPartV1,
} from '../../../server/gradebook/onedrive-sync/links/refresh-links-v1';
import {
  runLinkRefreshV1,
  type LinkRefreshPortsV1,
  type LinkRefreshResultV1,
} from '../../../server/gradebook/onedrive-sync/links/run-link-refresh-v1';
import { readSourceValuesV1 } from '../../../server/gradebook/onedrive-sync/links/source-values-v1';
import {
  crc32V1,
  readZipEntryV1,
  readZipPackageV1,
  rewriteZipPackageV1,
} from '../../../server/gradebook/onedrive-sync/links/zip-package-v1';
import { loadRealSheetJsV1 } from '../fixtures/sheetjs-real-v1';

/* ------------------------------------------------------------------ synthetic packages */

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const wide = (text: string) => {
  const bytes = new Uint8Array(4 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, text.length, true);
  for (let i = 0; i < text.length; i++) view.setUint16(4 + i * 2, text.charCodeAt(i), true);
  return bytes;
};
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const record = (type: number, ...parts: Uint8Array[]): Biff12RecordV1 => ({
  type,
  data: join(...parts),
});
const real = (value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
};

const DRIVE_ID = `b!${'A1b2C3d4E5f6G7h8I9j0'.repeat(3)}`;
const SOURCE_ID = `01${'SYNTHETICSOURCEITEM0000000000000'.slice(0, 32)}`;

/** An external link cache like Excel writes: sheet names, two rows of cells, the source ids. */
function syntheticLinkBin(): Uint8Array {
  return writeBiff12RecordsV1([
    record(
      0x168,
      Uint8Array.of(0, 0, 4, 0, 0, 0),
      wide('rId1'),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff),
    ),
    record(0x13f4, wide(`https://synthetic.example/x.xlsb`), wide(DRIVE_ID), wide(SOURCE_ID)),
    record(0x167, u32(2), wide('Dados'), wide('Outra')),
    record(0x16b, u32(0), Uint8Array.of(0)),
    record(0x16e, u32(0)),
    record(0x173, u32(0), wide('Aluno A')),
    record(0x170, u32(1), real(5)),
    record(0x16f, u32(2)),
    record(0x173, u32(3), Uint8Array.of(0xff, 0xff, 0xff, 0xff)),
    record(0x16e, u32(1)),
    record(0x171, u32(0), Uint8Array.of(1)),
    record(0x172, u32(1), Uint8Array.of(0x2a)),
    record(0x16c),
    record(0x24c),
  ]);
}

/** BrtCalcProp as Excel writes it (recalcID 191029, flags off) between two other records. */
function syntheticWorkbookBin(): Uint8Array {
  const calc = new Uint8Array(26);
  new DataView(calc.buffer).setUint32(0, 191029, true);
  return writeBiff12RecordsV1([record(0x83), record(0x9d, calc), record(0x84)]);
}

/** A ZIP with stored entries (what matters here is the format, not the compression). */
function storedZip(files: Record<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc32V1(data), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc32V1(data), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return join(...locals, ...centrals, end);
}

const RELS = new TextEncoder().encode(
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="https://synthetic-my.sharepoint.com/personal/escola/Documents/PASTA%20A/ORIGEM.xlsb" TargetMode="External"/>' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="../PASTA%20A/ORIGEM.xlsb" TargetMode="External"/>' +
    '</Relationships>',
);

function syntheticDestination(link = syntheticLinkBin()): Uint8Array {
  return storedZip({
    '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
    'xl/workbook.bin': syntheticWorkbookBin(),
    'xl/vbaProject.bin': new TextEncoder().encode('synthetic macros stay as they are'),
    'xl/externalLinks/externalLink1.bin': link,
    'xl/externalLinks/_rels/externalLink1.bin.rels': RELS,
  });
}

const DRIVE = {
  driveId: DRIVE_ID,
  webUrl: 'https://synthetic-my.sharepoint.com/personal/escola/Documents',
};

function sourceValues(values: Record<string, LinkValueV1>, sheets = ['Dados', 'Outra']) {
  return {
    sheetNames: sheets,
    valueAt: (sheet: string, row: number, col: number) =>
      sheets.includes(sheet)
        ? (values[`${sheet}!${row},${col}`] ?? { kind: 'blank' as const })
        : undefined,
  };
}

const CURRENT: Record<string, LinkValueV1> = {
  'Dados!0,0': { kind: 'string', value: 'Aluno A' },
  'Dados!0,1': { kind: 'number', value: 5 },
  'Dados!0,3': { kind: 'string', value: '' },
  'Dados!1,0': { kind: 'boolean', value: true },
  'Dados!1,1': { kind: 'error', code: 0x2a },
};

/* ------------------------------------------------------------------ cache codec */

describe('external link cache (.xlsb)', () => {
  it('reads sheet names, cells and the Graph ids of the source', () => {
    const cache = readXlsbLinkCacheV1(syntheticLinkBin());
    expect(cache.sheetNames).toEqual(['Dados', 'Outra']);
    expect(cache.driveId).toBe(DRIVE_ID);
    expect(cache.itemId).toBe(SOURCE_ID);
    expect(cache.cells.map((cell) => [cell.sheet, cell.row, cell.col, cell.value])).toEqual([
      ['Dados', 0, 0, { kind: 'string', value: 'Aluno A' }],
      ['Dados', 0, 1, { kind: 'number', value: 5 }],
      ['Dados', 0, 2, { kind: 'blank' }],
      ['Dados', 0, 3, { kind: 'string', value: '' }],
      ['Dados', 1, 0, { kind: 'boolean', value: true }],
      ['Dados', 1, 1, { kind: 'error', code: 0x2a }],
    ]);
  });

  it('gives back the same bytes when the values are the same (empty text as Excel writes it)', () => {
    const bytes = syntheticLinkBin();
    const values = sourceValues(CURRENT);
    const result = rewriteXlsbLinkCacheV1(bytes, (cell) =>
      values.valueAt(cell.sheet, cell.row, cell.col),
    );
    expect(result.changed).toBe(0);
    expect(result.bytes).toBe(bytes);
    // Decoding and encoding every record also gives the same bytes.
    expect(writeBiff12RecordsV1(readBiff12RecordsV1(bytes))).toEqual(bytes);
  });

  it('writes the new values and keeps every other record', () => {
    const bytes = syntheticLinkBin();
    const values = sourceValues({
      ...CURRENT,
      'Dados!0,0': { kind: 'string', value: 'Aluno A (novo nome)' },
      'Dados!0,1': { kind: 'string', value: 'FALTOU' },
      'Dados!0,2': { kind: 'number', value: 8.5 },
      'Dados!1,1': { kind: 'number', value: 0 },
    });
    const result = rewriteXlsbLinkCacheV1(bytes, (cell) =>
      values.valueAt(cell.sheet, cell.row, cell.col),
    );
    expect(result.changed).toBe(4);
    const after = readXlsbLinkCacheV1(result.bytes);
    expect(after.cells.map((cell) => cell.value)).toEqual([
      { kind: 'string', value: 'Aluno A (novo nome)' },
      { kind: 'string', value: 'FALTOU' },
      { kind: 'number', value: 8.5 },
      { kind: 'string', value: '' },
      { kind: 'boolean', value: true },
      { kind: 'number', value: 0 },
    ]);
    const cellTypes = new Set([0x16f, 0x170, 0x171, 0x172, 0x173]);
    const others = (input: Uint8Array) =>
      readBiff12RecordsV1(input).filter((item) => !cellTypes.has(item.type));
    expect(others(result.bytes)).toEqual(others(bytes));
  });

  it('keeps a cell whose sheet is missing in the source and refuses unknown errors', () => {
    const bytes = syntheticLinkBin();
    expect(rewriteXlsbLinkCacheV1(bytes, () => undefined).changed).toBe(0);
    expect(() => rewriteXlsbLinkCacheV1(bytes, () => ({ kind: 'error', code: 0x63 }))).toThrow(
      UnsupportedLinkValueError,
    );
  });
});

describe('external link cache (.xlsx)', () => {
  const xml =
    '<externalLink xmlns="x" xmlns:xxl21="y"><externalBook r:id="rId1">' +
    `<xxl21:alternateUrls driveId="${DRIVE_ID}" itemId="${SOURCE_ID}"><xxl21:absoluteUrl r:id="rId2"/></xxl21:alternateUrls>` +
    '<sheetNames><sheetName val="Dados"/><sheetName val="A &amp; B"/></sheetNames>' +
    '<sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1" t="str"><v>Aluno A</v></cell>' +
    '<cell r="B1"><v>5</v></cell><cell r="C1"/><cell r="D1" t="str"><v></v></cell></row>' +
    '<row r="2"><cell r="A2" t="b"><v>1</v></cell><cell r="B2" t="e"><v>#N/A</v></cell></row></sheetData>' +
    '<sheetData sheetId="1" refreshError="1"/></sheetDataSet></externalBook></externalLink>';

  it('reads the same cells and ids as the binary format', () => {
    const cache = readXlsxLinkCacheV1(xml);
    expect(cache.sheetNames).toEqual(['Dados', 'A & B']);
    expect([cache.driveId, cache.itemId]).toEqual([DRIVE_ID, SOURCE_ID]);
    expect(cache.cells.map((cell) => [cell.row, cell.col, cell.value])).toEqual([
      [0, 0, { kind: 'string', value: 'Aluno A' }],
      [0, 1, { kind: 'number', value: 5 }],
      [0, 2, { kind: 'blank' }],
      [0, 3, { kind: 'string', value: '' }],
      [1, 0, { kind: 'boolean', value: true }],
      [1, 1, { kind: 'error', code: 0x2a }],
    ]);
  });

  it('rewrites only the cells that changed, escaping text', () => {
    const values = sourceValues(
      { ...CURRENT, 'Dados!0,0': { kind: 'string', value: 'A < B & C' } },
      ['Dados', 'A & B'],
    );
    const same = rewriteXlsxLinkCacheV1(xml, (cell) =>
      cell.row === 0 && cell.col === 0
        ? CURRENT['Dados!0,0']
        : values.valueAt(cell.sheet, cell.row, cell.col),
    );
    expect(same).toEqual({ xml, changed: 0 });
    const changed = rewriteXlsxLinkCacheV1(xml, (cell) =>
      values.valueAt(cell.sheet, cell.row, cell.col),
    );
    expect(changed.changed).toBe(1);
    expect(changed.xml).toContain('<cell r="A1" t="str"><v>A &lt; B &amp; C</v></cell>');
    expect(readXlsxLinkCacheV1(changed.xml).cells[0]!.value).toEqual({
      kind: 'string',
      value: 'A < B & C',
    });
  });
});

describe('recalculation when the file is opened', () => {
  it('.xlsb: recalcID 0 and fFullCalcOnLoad, nothing else', () => {
    const before = syntheticWorkbookBin();
    const after = readBiff12RecordsV1(forceXlsbRecalcOnOpenV1(before));
    const calc = after.find((item) => item.type === 0x9d)!.data;
    expect(new DataView(calc.buffer, calc.byteOffset).getUint32(0, true)).toBe(0);
    expect(calc[24]! & 1).toBe(1);
    expect(after.map((item) => item.type)).toEqual([0x83, 0x9d, 0x84]);
    expect(() => forceXlsbRecalcOnOpenV1(writeBiff12RecordsV1([record(0x83)]))).toThrow();
  });

  it('.xlsx: calcPr fullCalcOnLoad="1"', () => {
    expect(forceXlsxRecalcOnOpenV1('<workbook><calcPr calcId="191029"/></workbook>')).toBe(
      '<workbook><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    );
    expect(
      forceXlsxRecalcOnOpenV1(
        '<workbook><calcPr fullCalcOnLoad="0" calcId="1"></calcPr></workbook>',
      ),
    ).toBe('<workbook><calcPr fullCalcOnLoad="1" calcId="1"></calcPr></workbook>');
    expect(() => forceXlsxRecalcOnOpenV1('<workbook/>')).toThrow();
  });
});

/* ------------------------------------------------------------------ package */

describe('workbook package', () => {
  it('replaces one part and copies every other entry byte for byte', async () => {
    const zip = syntheticDestination();
    const before = readZipPackageV1(zip);
    const replaced = new TextEncoder().encode('new content '.repeat(50));
    const out = await rewriteZipPackageV1(before, new Map([['xl/workbook.bin', replaced]]));
    const after = readZipPackageV1(out);
    expect(after.entries.map((entry) => entry.name)).toEqual(
      before.entries.map((entry) => entry.name),
    );
    expect(await readZipEntryV1(after, 'xl/workbook.bin')).toEqual(replaced);
    for (const name of [
      '[Content_Types].xml',
      'xl/vbaProject.bin',
      'xl/externalLinks/externalLink1.bin',
    ])
      expect(after.entries.find((entry) => entry.name === name)!.data).toEqual(
        before.entries.find((entry) => entry.name === name)!.data,
      );
  });

  it('keeps a real SheetJS workbook readable after a rewrite', async () => {
    const xlsx = await loadRealSheetJsV1();
    const workbook = {
      SheetNames: ['Dados'],
      Sheets: { Dados: { '!ref': 'A1:B1', A1: { t: 's', v: 'Aluno A' }, B1: { t: 'n', v: 7 } } },
    };
    const bytes = new Uint8Array(
      xlsx.write(workbook as never, { type: 'array', bookType: 'xlsb', compression: true }),
    );
    const pkg = readZipPackageV1(bytes);
    const name = pkg.entries.find((entry) => entry.name.startsWith('xl/worksheets/'))!.name;
    const sheet = (await readZipEntryV1(pkg, name))!;
    const out = await rewriteZipPackageV1(pkg, new Map([[name, sheet]]));
    const values = readSourceValuesV1(xlsx, out.slice().buffer, ['Dados']);
    expect(values.valueAt('Dados', 0, 0)).toEqual({ kind: 'string', value: 'Aluno A' });
    expect(values.valueAt('Dados', 0, 1)).toEqual({ kind: 'number', value: 7 });
    expect(values.valueAt('Dados', 5, 5)).toEqual({ kind: 'blank' });
    expect(values.valueAt('Sumiu', 0, 0)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ one destination */

describe('refresh of one workbook', () => {
  const link = (targets: string[], ids = true): LinkPartV1 => ({
    part: 'xl/externalLinks/externalLink1.bin',
    cache: {
      sheetNames: [],
      cells: [],
      driveId: ids ? DRIVE_ID : null,
      itemId: ids ? SOURCE_ID : null,
    },
    targets,
  });

  it('finds the source by the ids Excel stores, then by address inside the drive', () => {
    expect(resolveLinkSourceV1(link([]), DRIVE, 'X')).toEqual({
      kind: 'item',
      driveId: DRIVE_ID,
      itemId: SOURCE_ID,
    });
    expect(
      resolveLinkSourceV1(
        link(
          ['https://synthetic-my.sharepoint.com/personal/escola/Documents/PASTA%20A/ORIGEM.xlsb'],
          false,
        ),
        DRIVE,
        'X',
      ),
    ).toEqual({ kind: 'path', path: 'PASTA A/ORIGEM.xlsb' });
    expect(
      resolveLinkSourceV1(link(['../../PASTA%20A/ORIGEM.xlsb'], false), DRIVE, 'B/C/D'),
    ).toEqual({
      kind: 'path',
      path: 'B/PASTA A/ORIGEM.xlsb',
    });
    expect(
      resolveLinkSourceV1(
        link(
          ['https://outra-my.sharepoint.com/personal/x/Documents/a.xlsb', 'file:///C:/a.xlsb'],
          false,
        ),
        DRIVE,
        'X',
      ),
    ).toBeNull();
  });

  it('refreshes the cache from the source and asks for recalculation; nothing when equal', async () => {
    const destination = syntheticDestination();
    const same = await refreshDestinationLinksV1({
      bytes: destination,
      resolve: (item) => resolveLinkSourceV1(item, DRIVE, ''),
      loadSource: async () => sourceValues(CURRENT),
    });
    expect(same).toMatchObject({ outcome: 'unchanged', bytes: null, changedCells: 0 });
    const changed = await refreshDestinationLinksV1({
      bytes: destination,
      resolve: (item) => resolveLinkSourceV1(item, DRIVE, ''),
      loadSource: async () =>
        sourceValues({ ...CURRENT, 'Dados!0,1': { kind: 'number', value: 8 } }),
    });
    expect(changed.outcome).toBe('changed');
    expect(changed.changedCells).toBe(1);
    const { links } = await readDestinationLinksV1(changed.bytes!);
    expect(links[0]!.cache.cells[1]!.value).toEqual({ kind: 'number', value: 8 });
    const pkg = readZipPackageV1(changed.bytes!);
    const calc = readBiff12RecordsV1((await readZipEntryV1(pkg, 'xl/workbook.bin'))!).find(
      (item) => item.type === 0x9d,
    )!.data;
    expect(calc[24]! & 1).toBe(1);
    expect(await readZipEntryV1(pkg, 'xl/vbaProject.bin')).toEqual(
      new TextEncoder().encode('synthetic macros stay as they are'),
    );
  });

  it('leaves a link alone when its source did not change or cannot be read', async () => {
    for (const answer of ['skip', null] as const) {
      const result = await refreshDestinationLinksV1({
        bytes: syntheticDestination(),
        resolve: (item) => resolveLinkSourceV1(item, DRIVE, ''),
        loadSource: async () => answer,
      });
      expect(result.outcome).toBe('unchanged');
      expect(result.parts[0]!.status).toBe(answer === 'skip' ? 'same' : 'source-unavailable');
    }
  });
});

/* ------------------------------------------------------------------ the run (Graph ports) */

const ITEM = {
  id: 'dest-1',
  name: 'DESTINO.xlsb',
  size: 5000,
  lastModifiedDateTime: '2026-11-19T10:00:00Z',
  eTag: '"{DEST},3"',
  quickXorHash: 'hash-dest-3',
  folderPath: 'PASTA B',
};
const SOURCE = {
  ...ITEM,
  id: SOURCE_ID,
  name: 'ORIGEM.xlsb',
  eTag: '"{SRC},9"',
  quickXorHash: 'hash-src-9',
  folderPath: 'PASTA A',
};

function ports(overrides: Partial<LinkRefreshPortsV1> = {}, values = CURRENT) {
  const replace = vi.fn<LinkRefreshPortsV1['replace']>(async () => ({
    outcome: 'written',
    eTag: '"{DEST},4"',
    quickXorHash: 'hash-dest-4',
    lastModifiedDateTime: '2026-11-19T11:00:00Z',
  }));
  const download = vi.fn<LinkRefreshPortsV1['download']>(async (_drive, itemId) =>
    itemId === ITEM.id ? syntheticDestination().slice().buffer : new ArrayBuffer(8),
  );
  const base: LinkRefreshPortsV1 = {
    xlsx: {
      version: 'stub',
      read: () => ({ SheetNames: [], Sheets: {} }),
      utils: { decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }) },
    },
    now: () => 0,
    wallClock: () => Date.parse('2026-11-19T12:00:00Z'),
    item: async (_drive, itemId) =>
      itemId === ITEM.id ? ITEM : itemId === SOURCE_ID ? SOURCE : null,
    itemByPath: async () => null,
    download,
    replace,
  };
  return { ports: { ...base, ...overrides }, replace, download, values };
}

const INPUT = {
  driveId: DRIVE_ID,
  driveWebUrl: DRIVE.webUrl,
  itemId: ITEM.id,
  maxBytes: 8 * 1024 * 1024,
  onlySources: null,
  settleMs: 60_000,
};

describe('links refresh run', () => {
  // The source values come from SheetJS in production; here the read is replaced by a stub that
  // returns the synthetic values through the same module.
  const withValues = (values: Record<string, LinkValueV1>) => ({
    xlsx: {
      version: 'stub',
      read: () => {
        const sheet: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          const [, coords] = key.split('!');
          const [row, col] = coords!.split(',').map(Number);
          const address = `${String.fromCharCode(65 + col!)}${row! + 1}`;
          if (value.kind === 'string') sheet[address] = { t: 's', v: value.value };
          if (value.kind === 'number') sheet[address] = { t: 'n', v: value.value };
          if (value.kind === 'boolean') sheet[address] = { t: 'b', v: value.value };
          if (value.kind === 'error') sheet[address] = { t: 'e', v: value.code };
        }
        return { SheetNames: ['Dados', 'Outra'], Sheets: { Dados: sheet, Outra: {} } };
      },
      utils: { decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }) },
    } as LinkRefreshPortsV1['xlsx'],
  });

  it('writes at the version it read and reports its own write', async () => {
    const { ports: p, replace } = ports(
      withValues({ ...CURRENT, 'Dados!0,1': { kind: 'number', value: 9 } }),
    );
    const result = await runLinkRefreshV1(INPUT, p);
    expect(result).toMatchObject({
      outcome: 'written',
      sources: [SOURCE_ID],
      sourceHashes: { [SOURCE_ID]: 'hash-src-9' },
      changedCells: 1,
      written: { hash: 'hash-dest-4', modifiedAt: '2026-11-19T11:00:00Z' },
    });
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: ITEM.id, eTag: ITEM.eTag }),
    );
  });

  it('does not write when nothing changed, nor while the file is still being saved', async () => {
    const quiet = ports(withValues(CURRENT));
    expect((await runLinkRefreshV1(INPUT, quiet.ports)).outcome).toBe('unchanged');
    expect(quiet.replace).not.toHaveBeenCalled();
    const busy = ports({
      ...withValues(CURRENT),
      wallClock: () => Date.parse('2026-11-19T10:00:30Z'),
    });
    expect((await runLinkRefreshV1(INPUT, busy.ports)).outcome).toBe('settling');
    expect(busy.download).not.toHaveBeenCalled();
  });

  it('skips sources that did not change without downloading them', async () => {
    const { ports: p, download } = ports(
      withValues({ ...CURRENT, 'Dados!0,1': { kind: 'number', value: 9 } }),
    );
    const result = await runLinkRefreshV1({ ...INPUT, onlySources: ['another-source'] }, p);
    expect(result.outcome).toBe('unchanged');
    expect(result.sources).toEqual([SOURCE_ID]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('turns an open file and a save in between into a later retry', async () => {
    const changedValues = withValues({ ...CURRENT, 'Dados!0,1': { kind: 'number', value: 9 } });
    const locked = ports({ ...changedValues, replace: async () => ({ outcome: 'locked' }) });
    expect(await runLinkRefreshV1(INPUT, locked.ports)).toMatchObject({
      outcome: 'locked',
      code: 'FILE-OPEN',
    });
    const saved = ports({ ...changedValues, replace: async () => ({ outcome: 'changed' }) });
    expect((await runLinkRefreshV1(INPUT, saved.ports)).outcome).toBe('changed-meanwhile');
  });
});

/* ------------------------------------------------------------------ Graph upload */

describe('graphReplaceWorkbookV1', () => {
  async function env() {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const base64 = Buffer.from(
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    ).toString('base64');
    return {
      TENANT_ID: '00000000-0000-4000-8000-000000000001',
      GRAPH_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
      GRAPH_CREDENTIAL_A: JSON.stringify({
        privateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
        certificateThumbprint: 'synthetic-thumbprint-value',
        keyId: crypto.randomUUID(),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    };
  }
  const UPLOAD =
    'https://synthetic-my.sharepoint.com/personal/escola/_api/v2.0/uploadSession?guid=1';

  function graph(session: () => Response, upload: () => Response) {
    const calls: Array<{ method: string; url: string; headers: Headers }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://login.microsoftonline.com/'))
        return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
      calls.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) });
      if (url.includes('/createUploadSession')) return session();
      if (url === UPLOAD && init?.method === 'PUT') return upload();
      return new Response(null, { status: 204 });
    });
    return { calls, dependencies: { fetch, sleep: async () => undefined } };
  }
  const input = {
    driveId: 'drive-1',
    itemId: 'item-1',
    eTag: '"{ITEM},7"',
    bytes: new Uint8Array([1, 2, 3]),
  };

  it('sends if-match on the session and the bytes without the token', async () => {
    const mock = graph(
      () => Response.json({ uploadUrl: UPLOAD }),
      () =>
        Response.json({
          eTag: '"{ITEM},8"',
          lastModifiedDateTime: '2026-11-19T12:00:00Z',
          file: { hashes: { quickXorHash: 'h8' } },
        }),
    );
    expect(await graphReplaceWorkbookV1(await env(), input, mock.dependencies)).toEqual({
      outcome: 'written',
      eTag: '"{ITEM},8"',
      quickXorHash: 'h8',
      lastModifiedDateTime: '2026-11-19T12:00:00Z',
    });
    const [session, put] = mock.calls;
    expect(session!.headers.get('If-Match')).toBe('"{ITEM},7"');
    expect(put!.headers.get('Authorization')).toBeNull();
    expect(put!.headers.get('Content-Range')).toBe('bytes 0-2/3');
  });

  it('412 is a save in between, 423 an open file; the session is cancelled', async () => {
    const changed = graph(
      () => new Response(null, { status: 412 }),
      () => new Response(null),
    );
    expect(await graphReplaceWorkbookV1(await env(), input, changed.dependencies)).toEqual({
      outcome: 'changed',
    });
    const openAtSession = graph(
      () => new Response(null, { status: 423 }),
      () => new Response(null),
    );
    expect(await graphReplaceWorkbookV1(await env(), input, openAtSession.dependencies)).toEqual({
      outcome: 'locked',
    });
    const openAtUpload = graph(
      () => Response.json({ uploadUrl: UPLOAD }),
      () => new Response(null, { status: 423 }),
    );
    expect(await graphReplaceWorkbookV1(await env(), input, openAtUpload.dependencies)).toEqual({
      outcome: 'locked',
    });
    expect(openAtUpload.calls.at(-1)).toMatchObject({ method: 'DELETE', url: UPLOAD });
  });

  it('never sends the bytes to a host outside SharePoint', async () => {
    const mock = graph(
      () => Response.json({ uploadUrl: 'https://evil.example/upload' }),
      () => new Response(null),
    );
    await expect(graphReplaceWorkbookV1(await env(), input, mock.dependencies)).rejects.toThrow();
    expect(mock.calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

/* ------------------------------------------------------------------ coordinator rules */

describe('link rules', () => {
  const NOW = 1_000_000;
  const file = (extra: Partial<LinkFileV1> = {}): LinkFileV1 => ({
    ...newLinkFileV1(
      { id: 'dest-1', name: 'DESTINO.xlsb', hash: 'h1', modifiedAt: 't1' },
      'folder-1',
      NOW,
    ),
    state: 'idle',
    dueAt: null,
    changed: [],
    sources: ['src-1', 'src-2'],
    ...extra,
  });
  const result = (extra: Partial<LinkRefreshResultV1>): LinkRefreshResultV1 => ({
    outcome: 'unchanged',
    code: null,
    sources: ['src-1', 'src-2'],
    sourceHashes: {},
    unavailableLinks: 0,
    changedCells: 0,
    seen: { name: 'DESTINO.xlsb', hash: 'h1', modifiedAt: 't1' },
    written: null,
    ms: 10,
    ...extra,
  });

  it('a saved source schedules its dependants after the settle, accumulating sources', () => {
    const once = requestLinkRefreshV1(file(), ['src-1'], NOW, LINK_SOURCE_SETTLE_MS_V1);
    expect(once).toMatchObject({
      state: 'pending',
      changed: ['src-1'],
      dueAt: NOW + LINK_SOURCE_SETTLE_MS_V1,
    });
    const twice = requestLinkRefreshV1(once, ['src-2'], NOW + 10, LINK_SOURCE_SETTLE_MS_V1);
    expect(twice.changed).toEqual(['src-1', 'src-2']);
    expect(requestLinkRefreshV1(twice, null, NOW + 20, 0).changed).toBeNull();
  });

  it('starts at most two at once, the oldest first', () => {
    const files = [
      file({ id: 'a', state: 'pending', dueAt: NOW - 5 }),
      file({ id: 'b', state: 'pending', dueAt: NOW - 9 }),
      file({ id: 'c', state: 'pending', dueAt: NOW - 1 }),
      file({ id: 'd', state: 'pending', dueAt: NOW + 50 }),
    ];
    expect(linkFilesToStartV1(files, NOW, true).map((item) => item.id)).toEqual(['b', 'a']);
    expect(linkFilesToStartV1(files, NOW, false)).toEqual([]);
  });

  it('an open file waits 2, 4, 8 and then 15 minutes; a written one records its own hash', () => {
    let current = startLinkRefreshV1(file({ state: 'pending', changed: ['src-1'] }), 'L1', NOW);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      current = finishLinkRefreshV1(current, 'L1', result({ outcome: 'locked' }), NOW)!;
      delays.push((current.dueAt! - NOW) / 60_000);
      expect(current.changed).toEqual(['src-1']);
      current = startLinkRefreshV1(current, 'L1', NOW);
    }
    expect(delays).toEqual([2, 4, 8, 15, 15]);
    const written = finishLinkRefreshV1(
      current,
      'L1',
      result({ outcome: 'written', changedCells: 3, written: { hash: 'h2', modifiedAt: 't2' } }),
      NOW,
    )!;
    expect(written).toMatchObject({
      state: 'idle',
      ownHash: 'h2',
      hash: 'h2',
      changedCells: 3,
      lastWrittenAt: NOW,
      attempts: 0,
    });
    expect(finishLinkRefreshV1(written, 'L1', result({}), NOW)).toBeNull();
  });

  it('a source saved during the refresh starts another one', () => {
    const working = startLinkRefreshV1(file({ state: 'pending', changed: ['src-1'] }), 'L1', NOW);
    const touched = requestLinkRefreshV1(working, ['src-2'], NOW + 5, LINK_SOURCE_SETTLE_MS_V1);
    expect(touched.changedWhileWorking).toEqual(['src-2']);
    const done = finishLinkRefreshV1(touched, 'L1', result({}), NOW + 10)!;
    expect(done).toMatchObject({ state: 'pending', changed: ['src-2'] });
  });

  it('only real content changes of a source count, never the refresh\u2019s own write', () => {
    const items = [
      { id: 'src-1', hash: 'new', deleted: false },
      { id: 'src-2', hash: 'same', deleted: false },
      { id: 'dest-1', hash: 'mine', deleted: false },
      { id: 'gone', hash: null, deleted: true },
    ];
    const { changed, seen } = changedSourcesV1(
      items,
      { 'src-1': 'old', 'src-2': 'same' },
      new Map([['dest-1', 'mine']]),
    );
    expect(changed).toEqual(['src-1']);
    expect(seen).toEqual({ 'src-1': 'new', 'src-2': 'same', 'dest-1': 'mine' });
  });

  it('a workbook belongs to a chosen folder (direct children) or is chosen itself', () => {
    const targets = {
      f: { itemId: 'f', kind: 'folder' as const, path: 'A', setBy: 'x', setAt: 0 },
      w: { itemId: 'w', kind: 'file' as const, path: 'B/w.xlsb', setBy: 'x', setAt: 0 },
    };
    expect(linkTargetOfV1({ id: 'x', parentId: 'f' }, targets)?.itemId).toBe('f');
    expect(linkTargetOfV1({ id: 'w', parentId: 'other' }, targets)?.itemId).toBe('w');
    expect(linkTargetOfV1({ id: 'y', parentId: 'other' }, targets)).toBeNull();
  });
});
