import type { SourceFileManifestV1 } from '../../../shared/gradebook-contracts/imports/import-contract-v1';
import type { BatchSuccess } from '../../../src/features/gradebook/import/import-batch';
import type {
  SheetJs,
  Workbook as ProductionWorkbook,
  WorkbookSummary,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';
import {
  a1CoordinatesV1,
  type WorksheetCellV1,
  type WorksheetV1,
} from './worksheet-cell-access-v1';
import { SYNTHETIC_TEACHER_WORKBOOK } from './synthetic-teacher-workbooks';

export type WorkbookFixtureV1 = {
  SheetNames: string[];
  Sheets: Record<string, WorksheetV1>;
};

export interface WorkbookReaderEquivalenceCaseV1 {
  readonly id: string;
  readonly workbook: WorkbookFixtureV1;
  readonly expectation: 'request' | 'canonical-error' | 'reader-error';
  readonly error?: string;
}

function teacherFixture(): WorkbookFixtureV1 {
  const workbook: WorkbookFixtureV1 = structuredClone(SYNTHETIC_TEACHER_WORKBOOK);
  // The older recognition corpus intentionally has incomplete additional offers.
  // This corpus needs one complete V9 offer before introducing each edge case.
  for (const name of ['6B1º', '6A2ºD2', '6A3ºD3']) {
    workbook.SheetNames = workbook.SheetNames.filter((candidate) => candidate !== name);
    delete workbook.Sheets[name];
  }
  for (const name of ['6A2º', '6A3º']) {
    for (let row = 5; row <= 10; row += 1) {
      for (const column of ['G', 'J', 'K']) {
        workbook.Sheets[name]![`${column}${row}`] = structuredClone(
          workbook.Sheets['6A1º']![`${column}${row}`],
        );
      }
    }
  }
  for (const name of workbook.SheetNames) {
    if (!/^[6-9][A-Z](?:[123]º)(?:D\d+)?$/u.test(name)) continue;
    const sheet = workbook.Sheets[name]!;
    sheet['!ref'] = 'A1:AN50';
    sheet.R3 = { t: 'n', v: 8 };
    sheet.S3 = { t: 'n', v: 5.5 };
    sheet.AA5 = { t: 'n', v: 1 };
    sheet.AB5 = { t: 'n', v: 2 };
    delete sheet.AD5;
  }
  return workbook;
}

function teacherCase(
  id: string,
  mutate: (workbook: WorkbookFixtureV1) => void = () => {},
  expectation: WorkbookReaderEquivalenceCaseV1['expectation'] = 'request',
  error?: string,
): WorkbookReaderEquivalenceCaseV1 {
  const workbook = teacherFixture();
  mutate(workbook);
  return { id, workbook, expectation, ...(error === undefined ? {} : { error }) };
}

function relationFixture(): WorkbookFixtureV1 {
  return {
    SheetNames: ['INICIO', 'VÍNCULO AGENDA', 'AUXILIAR VAZIA'],
    Sheets: {
      INICIO: {
        '!ref': 'A1:Q28',
        Q2: { t: 'n', v: 2026 },
        D7: { t: 'n', v: 6 },
        E7: { t: 's', v: '6A' },
        F7: { t: 's', v: 'Turma Sintética A' },
        I7: { t: 's', v: 'MATUTINO' },
        D8: { t: 'n', v: 6 },
        E8: { t: 's', v: '6B' },
        F8: { t: 's', v: 'Turma Sintética B' },
        I8: { t: 's', v: 'VESPERTINO' },
        D28: { t: 'n', v: 9 },
        E28: { t: 's', v: '9V' },
        F28: { t: 's', v: 'Turma Sintética Final' },
        I28: { t: 's', v: 'VESPERTINO' },
      },
      'VÍNCULO AGENDA': {
        '!ref': 'A1:AZ48',
        I3: { t: 's', v: 'NOVATO' },
        J3: { t: 's', v: 'Estudante Fictício Inicial' },
        I4: { t: 's', v: 'FOI PARA 6B' },
        J4: { t: 's', v: 'Estudante Fictício Transferido' },
        K4: { t: 's', v: 'ESTAVA NO 6A' },
        L4: { t: 's', v: 'Estudante Fictício Transferido' },
        I5: { t: 's', v: 'ESPECIAL' },
        J5: { t: 's', v: 'Estudante Fictício Especial' },
        I6: { t: 's', v: 'ASSISTIDO' },
        J6: { t: 's', v: 'Estudante Fictício Assistido' },
        I7: { t: 's', v: 'DESISTENTE' },
        J7: { t: 's', v: 'Estudante Fictício Desistente' },
        I8: { t: 's', v: 'TRANSFERIDO' },
        J8: { t: 's', v: 'Estudante Fictício Externo' },
        I9: { t: 's', v: 'FALECIDO' },
        J9: { t: 's', v: 'Estudante Fictício Histórico' },
        AY48: { t: 's', v: 'NOVATO' },
        AZ48: { t: 's', v: 'Estudante Fictício Último' },
      },
      'AUXILIAR VAZIA': {},
    },
  };
}

function relationCase(
  id: string,
  mutate: (workbook: WorkbookFixtureV1) => void = () => {},
  error?: string,
): WorkbookReaderEquivalenceCaseV1 {
  const workbook = relationFixture();
  mutate(workbook);
  return {
    id,
    workbook,
    expectation: error === undefined ? 'request' : 'reader-error',
    ...(error === undefined ? {} : { error }),
  };
}

/** Object fixtures cover representation semantics; real codecs are measured separately. */
export const WORKBOOK_READER_EQUIVALENCE_CASES_V1: readonly WorkbookReaderEquivalenceCaseV1[] = [
  teacherCase('teacher'),
  teacherCase('numeric-text', (workbook) => {
    Object.assign(workbook.Sheets['6A1º']!, {
      R5: { t: 's', v: '0,1' },
      S5: { t: 's', v: '7.25' },
      Z5: { t: 's', v: '0' },
      AA5: { t: 's', v: '2,5' },
    });
  }),
  teacherCase(
    'negative-grade',
    (workbook) => {
      workbook.Sheets['6A1º']!.AA5 = { t: 'n', v: -1 };
    },
    // Partial hold (BN-DEC-045): the cell and the student's AM are held; the rest is written.
    'request',
  ),
  teacherCase(
    'invalid-text',
    (workbook) => {
      workbook.Sheets['6A1º']!.R5 = { t: 's', v: 'texto inválido sintético' };
    },
    // Partial hold (BN-DEC-045): the cell and the student's AM are held; the rest is written.
    'request',
  ),
  teacherCase('formula-caches', (workbook) => {
    Object.assign(workbook.Sheets['6A1º']!, {
      R5: { t: 'n', v: 0, f: 'SUM(R6:R7)' },
      S5: { t: 'n', v: 7.5, f: 'SUM(S6:S7)' },
      T5: { t: 'n', v: 0, f: 'SUM(R5:S5)' },
      AA5: { t: 'str', v: '', f: 'IF(R5=0,"",R5)' },
      AB5: { t: 'n', f: 'SUM(AB6:AB7)' },
      AC5: { t: 'e', v: 7, f: '1/0', w: '#DIV/0!' },
      AM5: { t: 'n', f: 'SUM(T5:AK5)', w: '#N/A' },
      AN5: { t: 'str', v: '', f: 'IF(AM5=0,"",AM5)' },
    });
  }),
  teacherCase('formatted-text-fallback', (workbook) => {
    workbook.Sheets['CONFIGURAÇÃO']!.A2 = { w: ' Docente Fictício Formatado ' };
    Object.assign(workbook.Sheets['6A1º']!, {
      K2: { w: 'Matemática Sintética' },
      K3: { w: '6A' },
      K4: { w: '1º trimestre' },
      K5: { w: 'Estudante Fictício Formatado' },
      G5: { w: 'NOVATO' },
      AM5: { f: 'SUM(T5:AK5)', w: '#VALUE!' },
    });
    workbook.Sheets['6AREC']!.AC5 = { f: 'IF(R5>0,1,0)', w: '#N/A' };
  }),
  teacherCase('holes-and-no-v', (workbook) => {
    const sheet = workbook.Sheets['6A1º']!;
    delete sheet.R6;
    delete sheet.S6;
    sheet.R5 = {};
    sheet.S5 = { v: undefined };
    sheet.AA5 = { t: 'z' };
    sheet.AB5 = { t: 'n', v: null };
    sheet.AM5 = { f: 'SUM(T5:AK5)', v: undefined };
  }),
  teacherCase('dimensions-fullref', (workbook) => {
    workbook.Sheets['6A1º']!['!fullref'] = 'A1:AZ100000';
    workbook.Sheets['6A1º']!['!ref'] = 'A1:AN50';
  }),
  teacherCase(
    'missing-ref',
    (workbook) => {
      delete workbook.Sheets['6A1º']!['!ref'];
    },
    'canonical-error',
    // The only offer is held, so nothing in the file can be written.
    'Nenhuma turma desta planilha pôde ser lançada. Os números dos alunos divergem entre trimestres em 6A / Matemática Sintética.',
  ),
  teacherCase('last-student-row', (workbook) => {
    for (const name of ['6A1º', '6A2º', '6A3º']) {
      Object.assign(workbook.Sheets[name]!, {
        G50: { t: 's', v: 'ATIVO' },
        J50: { t: 'n', v: 46 },
        K50: { t: 's', v: 'Estudante Fictício Linha Cinquenta' },
        R50: { t: 'n', v: 0.1 },
        S50: { t: 'n', v: 0 },
        AA50: { t: 'n', v: 2.5 },
        AM50: { t: 'n', v: 9 },
        AN50: { t: 'n', v: 20 },
      });
    }
  }),
  teacherCase('configuration-filename-fallback', (workbook) => {
    delete workbook.Sheets['CONFIGURAÇÃO']!.A2;
  }),
  teacherCase('qualitative-definitions', (workbook) => {
    Object.assign(workbook.Sheets['6A1º']!, {
      R3: { t: 'n', v: 10 },
      S3: { t: 'n', v: 6 },
      AA3: { t: 'n', v: 0 },
      AA4: { t: 's', v: '*' },
      AA5: { t: 'z' },
      AB3: { t: 'n', v: 4.5 },
      AB4: { t: 's', v: ' Produção Sintética Decimal ' },
      AB5: { t: 'n', v: 0.1 },
      AC3: { t: 'n', f: 'SUM(AC1:AC2)' },
      AC4: { t: 's', v: 'Cabeçalho Sintético Indisponível' },
      AD3: { t: 's', v: '' },
      AD4: { t: 's', v: '' },
      AD5: { t: 's', v: '' },
    });
  }),
  teacherCase('recovery-markers-and-masks', (workbook) => {
    Object.assign(workbook.Sheets['6AREC']!, {
      R5: { t: 's', v: 'N/C' },
      S5: { t: 's', v: 'R/R' },
      T5: { t: 'n', f: 'SUM(T6:T7)', w: '#N/A' },
      U5: { t: 'n', v: 0, f: 'SUM(R5:T5)' },
      AC5: { t: 'n', v: 1, f: 'IF(R5>0,1,0)' },
      AD5: { t: 'n', v: 0 },
      AE5: { t: 'str', v: '', f: 'IF(T5>0,1,0)' },
    });
    workbook.Sheets['6A1º']!.AM5 = { t: 'n', v: 0.1 };
  }),
  teacherCase('dates-booleans-merges-and-unknown', (workbook) => {
    workbook.SheetNames.push('VAZIA SEM REF', 'DESCONHECIDA');
    workbook.Sheets['VAZIA SEM REF'] = {};
    workbook.Sheets.DESCONHECIDA = {
      '!ref': 'A1:B2',
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
      A1: { t: 'd', v: new Date('2026-01-05T00:00:00.000Z') },
      A2: { t: 'b', v: false },
      B2: { t: 'b', v: true },
    };
    workbook.Sheets['6A1º']!.R5 = { t: 'd', v: new Date('2026-01-05T00:00:00.000Z') };
    workbook.Sheets['6AREC']!.AC5 = { t: 'b', v: false };
  }),
  relationCase('relation'),
  relationCase('relation-formatted-fallback', (workbook) => {
    workbook.Sheets.INICIO!.E7 = { w: '6A' };
    workbook.Sheets.INICIO!.Q2 = { w: '2026' };
    workbook.Sheets['VÍNCULO AGENDA']!.AZ48 = { w: 'Estudante Fictício Último' };
  }),
  relationCase(
    'relation-invalid-year',
    (workbook) => {
      workbook.Sheets.INICIO!.Q2 = { t: 's', v: 'ano inválido' };
    },
    'Ano letivo inválido ou ausente em INICIO!Q2.',
  ),
  relationCase(
    'relation-invalid-status',
    (workbook) => {
      workbook.Sheets['VÍNCULO AGENDA']!.I3 = { t: 's', v: 'SITUAÇÃO SINTÉTICA INVÁLIDA' };
    },
    'Situação da Relação não reconhecida: SITUAÇÃO SINTÉTICA INVÁLIDA',
  ),
  relationCase(
    'relation-invalid-transfer',
    (workbook) => {
      workbook.Sheets['VÍNCULO AGENDA']!.I4 = { t: 's', v: 'FOI PARA 7Z' };
    },
    'Movimentação de Estudante Fictício Transferido referencia turma inexistente: 7Z.',
  ),
  {
    id: 'auxiliary-only',
    workbook: {
      SheetNames: ['INICIO'],
      Sheets: { INICIO: { '!ref': 'A1:A1', A1: { v: 'Auxiliar' } } },
    },
    expectation: 'reader-error',
    error: 'Nenhuma guia corresponde ao padrão de notas configurado.',
  },
  {
    id: 'empty-workbook',
    workbook: { SheetNames: [], Sheets: {} },
    expectation: 'reader-error',
    error: 'A planilha não contém abas reconhecíveis.',
  },
];

/** No sparse address is retained in a dense fixture; absent rows/cells remain holes. */
export function densifyFixtureV1(input: WorkbookFixtureV1): WorkbookFixtureV1 {
  const workbook = structuredClone(input);
  for (const name of workbook.SheetNames) {
    const source = workbook.Sheets[name];
    if (!source) continue;
    const rows: Array<Array<WorksheetCellV1 | undefined> | undefined> = [];
    const dense: WorksheetV1 = { '!data': rows };
    for (const [address, value] of Object.entries(source)) {
      if (address.startsWith('!')) {
        if (address !== '!data') dense[address] = value;
        continue;
      }
      const coordinate = a1CoordinatesV1(address);
      if (!coordinate || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = rows[coordinate.row - 1] ?? [];
      rows[coordinate.row - 1] = row;
      row[coordinate.column - 1] = value as WorksheetCellV1;
    }
    workbook.Sheets[name] = dense;
  }
  return workbook;
}

export function syntheticResultV1(
  manifest: SourceFileManifestV1,
  summary: WorkbookSummary,
): BatchSuccess {
  return { id: 'import-file:reader-equivalence' as BatchSuccess['id'], manifest, summary };
}

/** Functional adapter only: it returns independently cloned objects, never benchmarks parsing. */
export function createFixtureSheetJsV1(workbook: WorkbookFixtureV1): SheetJs {
  function decodeCell(address: string): { r: number; c: number } {
    const coordinate = a1CoordinatesV1(address);
    if (!coordinate) throw new Error(`Endereço sintético inválido: ${address}`);
    return { r: coordinate.row - 1, c: coordinate.column - 1 };
  }
  return {
    version: 'functional-fixture-adapter',
    // SheetJs keeps the unchanged production sparse type. The isolated candidate
    // deliberately supplies the wider fixture representation at this boundary.
    read: () => structuredClone(workbook) as unknown as ProductionWorkbook,
    utils: {
      decode_range: (range) => {
        const [start, end = start] = range.split(':');
        if (!start) throw new Error(`Faixa sintética inválida: ${range}`);
        return { s: decodeCell(start), e: decodeCell(end!) };
      },
    },
  };
}
