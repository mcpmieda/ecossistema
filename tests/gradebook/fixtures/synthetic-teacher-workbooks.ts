import { SOURCE_CELL_MAP_V1 } from '../../../shared/gradebook-contracts/source/source-contract-v1';
import type {
  SheetJs,
  Workbook,
  Worksheet,
} from '../../../src/features/gradebook/import/spreadsheet-recognizer';

type SyntheticCell = {
  v?: unknown;
  w?: string;
  f?: string;
};

type SyntheticStudent = {
  row: number;
  number: number;
  name: string;
  status: string;
  cells?: Record<string, SyntheticCell>;
};

type SyntheticFileDescriptor = {
  marker: number;
  name: string;
  workbook: Workbook;
};

const { metadata, studentColumns, termColumns, recoveryColumns } = SOURCE_CELL_MAP_V1;

function address(column: string, row: number): string {
  return `${column}${row}`;
}

function gradeSheet(input: {
  subject: string;
  classGroup: string;
  stage: string;
  declaredStudents: number;
  students: SyntheticStudent[];
  assessmentHeaders?: Record<string, SyntheticCell>;
}): Worksheet {
  const sheet: Worksheet = {
    '!ref': `A1:AN${Math.max(10, ...input.students.map((student) => student.row))}`,
    [metadata.declaredStudentCount]: { v: input.declaredStudents },
    [metadata.subject]: { v: input.subject },
    [metadata.classGroup]: { v: input.classGroup },
    [metadata.stage]: { v: input.stage },
    ...input.assessmentHeaders,
  };

  for (const student of input.students) {
    sheet[address(studentColumns.status, student.row)] = { v: student.status };
    sheet[address(studentColumns.number, student.row)] = { v: student.number };
    sheet[address(studentColumns.name, student.row)] = { v: student.name };
    for (const [column, cell] of Object.entries(student.cells ?? {})) {
      sheet[address(column, student.row)] = cell;
    }
  }

  return sheet;
}

const LONG_UNICODE_ACTIVITY_NAME =
  'Produção científica — investigação sobre frações, proporções e aplicações no cotidiano escolar sintético';

const TERM_1_ASSESSMENT_HEADERS: Record<string, SyntheticCell> = {
  R3: { v: 8 },
  S3: { v: 5.5 },
  AA3: { v: 3 },
  AA4: { v: 'Pesquisa sobre frações' },
  AB3: { v: 4 },
  AB4: { v: 'Seminário' },
  AC3: { v: '' },
  AC4: { v: 'Atividade nomeada sem máximo' },
  AD3: { v: '*' },
  AD4: { v: LONG_UNICODE_ACTIVITY_NAME },
  AE3: { v: 2.5 },
  AE4: { v: 'Leitura e síntese' },
};

const TERM_2_ASSESSMENT_HEADERS: Record<string, SyntheticCell> = {
  ...TERM_1_ASSESSMENT_HEADERS,
  S3: { v: '*' },
  AA3: { v: 4 },
  AA4: { v: 'Pesquisa sobre frações — versão revisada' },
};

const TERM_3_ASSESSMENT_HEADERS: Record<string, SyntheticCell> = {
  S3: { v: 6 },
  AA4: { v: 'Pesquisa com definição ausente' },
  AB3: { v: 5 },
  AB4: { v: 'Apresentação final' },
};

const primaryStudents: SyntheticStudent[] = [
  {
    row: 5,
    number: 1,
    name: 'Estudante Fictício 01',
    status: 'ATIVO',
    cells: {
      [termColumns.writtenAssessment]: { v: 0.1 },
      [termColumns.secondAssessment]: { v: 0 },
      [termColumns.quantitativeTotal]: { v: 7.5, f: 'SUM(R5:S5)' },
      [termColumns.parallelAssessment]: { v: 0, f: 'SUM(R5:S5)' },
      AA: { v: -1 },
      AB: { v: 'texto-sintetico-invalido' },
      AC: { f: 'SUM(AA5:AB5)', w: '#N/A' },
      AD: { v: null },
      AE: { v: 2.5 },
      [termColumns.qualitativeTotal]: { v: 8 },
      [termColumns.officialTermGrade]: { v: 9.5 },
      [termColumns.annualAccumulatedTotal]: { v: 20 },
    },
  },
  {
    row: 6,
    number: 2,
    name: 'Estudante Fictício Novato',
    status: 'NOVATO',
    cells: {
      [termColumns.officialTermGrade]: { v: 7 },
      [termColumns.annualAccumulatedTotal]: { v: 18 },
    },
  },
  {
    row: 7,
    number: 3,
    name: 'Estudante Fictício Transferido',
    status: 'FOI PARA 6B',
    cells: {
      [termColumns.officialTermGrade]: { v: 6 },
      [termColumns.annualAccumulatedTotal]: { v: 16 },
    },
  },
  {
    row: 8,
    number: 4,
    name: 'Estudante Fictício Histórico',
    status: 'TRANSFERIDO',
    cells: {
      [termColumns.officialTermGrade]: { v: 5.5 },
      [termColumns.annualAccumulatedTotal]: { v: 14 },
    },
  },
  {
    row: 9,
    number: 5,
    name: '.Estudante Fictício Homônimo',
    status: 'ATIVO',
    cells: { [termColumns.officialTermGrade]: { v: 8.5 } },
  },
  {
    row: 10,
    number: 6,
    name: 'Estudante Fictício Homônimo',
    status: 'ATIVO',
    cells: { [termColumns.officialTermGrade]: { v: 8 } },
  },
];

const transferredStudentAtDestination: SyntheticStudent = {
  row: 5,
  number: 3,
  name: 'Estudante Fictício Transferido',
  status: 'ESTAVA NO 6A',
  cells: {
    [termColumns.officialTermGrade]: { v: 6 },
    [termColumns.annualAccumulatedTotal]: { v: 16 },
  },
};

const recoveryStudents: SyntheticStudent[] = [
  {
    row: 5,
    number: 1,
    name: 'Estudante Fictício 01',
    status: 'ATIVO',
    cells: {
      [recoveryColumns.recoveryTerm1]: { v: 12 },
      [recoveryColumns.recoveryTerm2]: { v: 13 },
      [recoveryColumns.recoveryTerm3]: { v: 14 },
      [recoveryColumns.annualTotalAfterRecovery]: { v: 62 },
      [recoveryColumns.originalTerm1]: { v: 15 },
      [recoveryColumns.originalTerm2]: { v: 18 },
      [recoveryColumns.originalTerm3]: { v: 20 },
      [recoveryColumns.originalAnnualTotal]: { v: 53 },
      [recoveryColumns.recoveryAppliesToTerm1]: { v: 1 },
      [recoveryColumns.recoveryAppliesToTerm2]: { v: 0 },
      [recoveryColumns.recoveryAppliesToTerm3]: { v: 1 },
    },
  },
  {
    row: 6,
    number: 2,
    name: 'Estudante Fictício Novato',
    status: 'ATIVO',
    cells: {
      [recoveryColumns.recoveryTerm1]: { v: 10 },
      [recoveryColumns.recoveryTerm3]: { v: 11 },
      [recoveryColumns.annualTotalAfterRecovery]: { v: 60 },
      [recoveryColumns.originalTerm1]: { v: 12 },
      [recoveryColumns.originalTerm2]: { v: 17 },
      [recoveryColumns.originalTerm3]: { v: 19 },
      [recoveryColumns.originalAnnualTotal]: { v: 48 },
      [recoveryColumns.recoveryAppliesToTerm1]: { v: 1 },
      [recoveryColumns.recoveryAppliesToTerm3]: { v: 1 },
    },
  },
];

export const SYNTHETIC_TEACHER_WORKBOOK: Workbook = {
  SheetNames: [
    '6AVG',
    '6A1º',
    '6B1º',
    '6A2º',
    '6A2ºD2',
    '6A3º',
    '6A3ºD3',
    '6AREC',
    'RELAÇÃO',
    'CONFIGURAÇÃO',
    'INICIO',
    'AUXILIAR OCULTA',
  ],
  Sheets: {
    '6AVG': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6A',
      stage: 'Visão geral',
      declaredStudents: 2,
      students: primaryStudents.slice(0, 2),
    }),
    '6A1º': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6A',
      stage: '1º trimestre',
      declaredStudents: 2,
      students: primaryStudents,
      assessmentHeaders: TERM_1_ASSESSMENT_HEADERS,
    }),
    '6B1º': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6B',
      stage: '1º trimestre',
      declaredStudents: 1,
      students: [transferredStudentAtDestination],
      assessmentHeaders: TERM_1_ASSESSMENT_HEADERS,
    }),
    '6A2º': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6A',
      stage: '2º trimestre',
      declaredStudents: 2,
      students: primaryStudents.slice(0, 2),
      assessmentHeaders: TERM_2_ASSESSMENT_HEADERS,
    }),
    '6A2ºD2': gradeSheet({
      subject: 'Ciências Sintéticas',
      classGroup: '6A',
      stage: '2º trimestre',
      declaredStudents: 2,
      students: primaryStudents.slice(0, 2),
      assessmentHeaders: TERM_2_ASSESSMENT_HEADERS,
    }),
    '6A3º': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6A',
      stage: '3º trimestre',
      declaredStudents: 2,
      students: primaryStudents.slice(0, 2),
      assessmentHeaders: TERM_3_ASSESSMENT_HEADERS,
    }),
    '6A3ºD3': gradeSheet({
      subject: 'Projeto Sintético',
      classGroup: '6A',
      stage: '3º trimestre',
      declaredStudents: 2,
      students: primaryStudents.slice(0, 2),
      assessmentHeaders: TERM_3_ASSESSMENT_HEADERS,
    }),
    '6AREC': gradeSheet({
      subject: 'Matemática Sintética',
      classGroup: '6A',
      stage: 'Recuperação final',
      declaredStudents: 2,
      students: recoveryStudents,
    }),
    RELAÇÃO: { '!ref': 'A1:K2', A1: { v: 'Relação sintética' } },
    CONFIGURAÇÃO: {
      '!ref': 'A1:C2',
      A1: { v: 'Configuração sintética' },
      A2: { v: 'Docente Sintético da Configuração' },
      C2: { v: 2026 },
    },
    INICIO: { '!ref': 'A1:B2', A1: { v: 'Início sintético' } },
    'AUXILIAR OCULTA': { '!ref': 'A1:B2', A1: { v: 'Auxiliar sintética' } },
  },
};

export const SYNTHETIC_SHEET_CONTROLS = {
  protectedSheetNames: ['6A1º'],
  hiddenSheetNames: ['CONFIGURAÇÃO', 'AUXILIAR OCULTA'],
} as const;

export const SYNTHETIC_EXPECTATIONS = {
  source: {
    gradeSheetNames: ['6AVG', '6A1º', '6B1º', '6A2º', '6A2ºD2', '6A3º', '6A3ºD3', '6AREC'],
    auxiliarySheetNames: ['RELAÇÃO', 'CONFIGURAÇÃO', 'INICIO'],
    unrecognizedSheetNames: ['AUXILIAR OCULTA'],
    d1DeclaredStudents: 2,
    d1HistoricalPositions: 6,
  },
  cells: {
    officialZero: { source: 0.1, value: 0, kind: 'official-zero' },
    legacyZero: { source: 0, value: 0, kind: 'legacy-zero' },
    formulaNonzero: { source: 7.5, value: 7.5, kind: 'formula', formula: 'SUM(R5:S5)' },
    manualNegative: { source: -1, value: -1, kind: 'negative' },
    manualPositive: { source: 8, value: 8, kind: 'manual' },
  },
  transfer: {
    originStatus: 'FOI PARA 6B',
    destinationStatus: 'ESTAVA NO 6A',
    replicatedOfficialValue: 6,
  },
  recovery: {
    original: [15, 18, 20, 53],
    replacement: [12, 13, 14, 62],
    eligible: [true, false, true],
  },
} as const;

const EMPTY_WORKBOOK: Workbook = { SheetNames: [], Sheets: {} };
const AUXILIARY_ONLY_WORKBOOK: Workbook = {
  SheetNames: ['INICIO'],
  Sheets: { INICIO: { '!ref': 'A1:A1', A1: { v: 'Início sintético' } } },
};

export const SYNTHETIC_FILES = {
  xlsx: { marker: 1, name: 'massa-sintetica-a.xlsx', workbook: SYNTHETIC_TEACHER_WORKBOOK },
  xlsb: { marker: 2, name: 'massa-sintetica-b.xlsb', workbook: SYNTHETIC_TEACHER_WORKBOOK },
  xls: { marker: 3, name: 'massa-sintetica-c.xls', workbook: SYNTHETIC_TEACHER_WORKBOOK },
  noGradeSheet: {
    marker: 8,
    name: 'massa-sintetica-sem-guia.xlsx',
    workbook: AUXILIARY_ONLY_WORKBOOK,
  },
  empty: { marker: 9, name: 'massa-sintetica-vazia.xlsx', workbook: EMPTY_WORKBOOK },
} satisfies Record<string, SyntheticFileDescriptor>;

export function createSyntheticFile(
  descriptor: SyntheticFileDescriptor,
  events: string[] = [],
): File {
  return {
    name: descriptor.name,
    size: 1,
    lastModified: 1_788_134_400_000,
    arrayBuffer: async () => {
      events.push(`start:${descriptor.name}`);
      await Promise.resolve();
      events.push(`end:${descriptor.name}`);
      return Uint8Array.of(descriptor.marker).buffer;
    },
  } as unknown as File;
}

function columnIndex(column: string): number {
  return [...column].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function decodeCellAddress(cellAddress: string): { r: number; c: number } {
  const match = /^([A-Z]+)(\d+)$/u.exec(cellAddress);
  if (!match?.[1] || !match[2]) throw new Error(`Faixa sintética inválida: ${cellAddress}`);
  return { r: Number(match[2]) - 1, c: columnIndex(match[1]) };
}

export function createSyntheticSheetJs(events: string[] = []): SheetJs {
  const workbooks = new Map(
    Object.values(SYNTHETIC_FILES).map((descriptor) => [descriptor.marker, descriptor.workbook]),
  );

  return {
    version: 'synthetic-test-adapter',
    read: (data) => {
      const marker = new Uint8Array(data)[0];
      events.push(`read:${marker}`);
      const workbook = marker === undefined ? undefined : workbooks.get(marker);
      if (!workbook) throw new Error(`Marcador sintético não reconhecido: ${marker ?? 'ausente'}`);
      return workbook;
    },
    utils: {
      decode_range: (range) => {
        const [start, end] = range.split(':');
        if (!start || !end) throw new Error(`Faixa sintética inválida: ${range}`);
        return { s: decodeCellAddress(start), e: decodeCellAddress(end) };
      },
    },
  };
}
