import { comparePtBrNumericLabelsV1 } from '../../../../shared/gradebook-contracts/string-order-v1';
import {
  SOURCE_CONTRACT_VERSION_V2,
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2,
  classifySourceAssessmentMaximumConfigurationV2,
  classifySourceAssessmentNameV2,
  type SourceAssessmentDefinitionV2,
} from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type {
  SourceCellProvenanceV1,
  SourceCellRawValueV1,
} from '../../../../shared/gradebook-contracts/source/source-contract-v1';
import type { GradebookImportRecoveryApplicabilityObservationV3 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v3';
import type {
  GradebookImportResultCellObservationV4,
  GradebookImportTermResultObservationsV4,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v4';
import { scalarTextV1 } from '../../../../shared/scalar-text-v1';

/** The error text a cell carries: its value, else its formatted text, when not blank. */
function errorTextOf(cell: { v?: unknown; w?: unknown }) {
  if (typeof cell.v === 'string' && cell.v.trim()) return cell.v;
  return typeof cell.w === 'string' && cell.w.trim() ? cell.w : null;
}

export const ACCEPTED_EXTENSIONS = ['xlsx', 'xlsb', 'xls'] as const;

type Cell = {
  v?: unknown;
  w?: string;
  f?: string;
  t?: string;
};

/** Capture only a saved scalar. A saved empty string is blank, not a missing cache. */
export function snapshotRawCellV8(
  cell: Cell | undefined,
):
  | import('../../../../shared/gradebook-contracts/imports/import-persistence-transport-v8').GradebookSnapshotCellV8
  | null
  | undefined {
  if (!cell) return undefined;
  if (cell.t === 'e' || (cell.f && (cell.v === undefined || cell.v === null))) return ['u'];
  if (typeof cell.v === 'number') return Number.isFinite(cell.v) ? cell.v : ['u'];
  if (typeof cell.v === 'boolean') return cell.v;
  if (typeof cell.v === 'string') return cell.v.trim() === '' ? undefined : cell.v;
  return cell.v === undefined || cell.v === null ? undefined : ['u'];
}

export type Worksheet = {
  '!ref'?: string;
  [address: string]: Cell | string | undefined;
};

export type Workbook = {
  SheetNames: string[];
  Sheets: Record<string, Worksheet>;
};

export type SheetJs = {
  version: string;
  read: (data: ArrayBuffer, options?: Record<string, unknown>) => Workbook;
  utils: {
    decode_range: (range: string) => {
      s: { r: number; c: number };
      e: { r: number; c: number };
    };
  };
};

export type NoteValue = {
  source: number;
  value: number;
  // official-zero remains readable for historical evidence, never emitted for new 0.1 grades.
  kind: 'manual' | 'formula' | 'official-zero' | 'legacy-zero' | 'negative';
  formula?: string;
  snapshotState?: 'value' | 'unavailable';
};

export type RecoveryResultObservationsV4 = {
  readonly trimester1: GradebookImportResultCellObservationV4;
  readonly trimester2: GradebookImportResultCellObservationV4;
  readonly trimester3: GradebookImportResultCellObservationV4;
  readonly totalAfterRecovery: GradebookImportResultCellObservationV4;
  readonly originalTrimester1: GradebookImportResultCellObservationV4;
  readonly originalTrimester2: GradebookImportResultCellObservationV4;
  readonly originalTrimester3: GradebookImportResultCellObservationV4;
  readonly originalAnnual: GradebookImportResultCellObservationV4;
};

export type RecoveryRecognition = {
  trimester1: NoteValue | null;
  trimester2: NoteValue | null;
  trimester3: NoteValue | null;
  totalAfterRecovery: NoteValue | null;
  originalTrimester1: NoteValue | null;
  originalTrimester2: NoteValue | null;
  originalTrimester3: NoteValue | null;
  originalAnnual: NoteValue | null;
  resultObservations: RecoveryResultObservationsV4;
  applicabilityTrimester1: GradebookImportRecoveryApplicabilityObservationV3;
  applicabilityTrimester2: GradebookImportRecoveryApplicabilityObservationV3;
  applicabilityTrimester3: GradebookImportRecoveryApplicabilityObservationV3;
  /** Historical convenience projection. V3/V4 transports must use the raw observations above. */
  eligibleTrimester1: boolean;
  eligibleTrimester2: boolean;
  eligibleTrimester3: boolean;
};

export type StudentRecognition = {
  row: number;
  number: string;
  name: string;
  status: string;
  quantitativeAssessments: readonly [NoteValue | null, NoteValue | null];
  quantitativeTotal: NoteValue | null;
  parallel: NoteValue | null;
  qualitative: Array<NoteValue | null>;
  qualitativeTotal: NoteValue | null;
  official: NoteValue | null;
  annual: NoteValue | null;
  /** Rich source observations for T/Z/AK/AM/AN. Historical note fields remain unchanged. */
  termResultObservations: GradebookImportTermResultObservationsV4 | null;
  recovery: RecoveryRecognition | null;
};

export interface WorkbookRecognitionSourceV2 {
  readonly fileSha256: string;
  readonly captureValues?: boolean;
}

export type GradeStage = 'overview' | 'trimester-1' | 'trimester-2' | 'trimester-3' | 'recovery';

export type GradeSheetRecognition = {
  snapshotCellsV8?: Readonly<
    Record<
      string,
      | import('../../../../shared/gradebook-contracts/imports/import-persistence-transport-v8').GradebookSnapshotCellV8
      | null
    >
  >;
  name: string;
  range: string;
  rows: number;
  columns: number;
  className: string;
  discipline: string;
  disciplineIndex: string;
  stage: GradeStage;
  declaredStage: string;
  declaredStudents: number | null;
  assessmentDefinitions: readonly SourceAssessmentDefinitionV2[];
  students: StudentRecognition[];
  formulas: number;
  officialZeros: number;
};

export type ClassRecognition = {
  name: string;
  students: number;
  declaredStudents: number | null;
  disciplines: string[];
  trimesters: string[];
  recovery: boolean;
  sheets: GradeSheetRecognition[];
};

export type SheetSummary = {
  name: string;
  range: string;
  rows: number;
  columns: number;
};

export type WorkbookSummary = {
  fileName: string;
  format: string;
  size: number;
  parserVersion: string;
  academicYear?: number | null;
  teacherName?: string | null;
  sheets: SheetSummary[];
  gradeSheets: GradeSheetRecognition[];
  classes: ClassRecognition[];
  auxiliarySheets: string[];
  unrecognizedSheets: string[];
};

export function fileExtension(name: string): string {
  return name.split('.').pop()?.trim().toLowerCase() ?? '';
}

const isSpace = (character: string) => /\s/u.test(character);

/**
 * The text without a year at its end and the separators before it ("MARIA - 2026" → "MARIA"),
 * read from the end in place of /\s*[-–—_:]*\s*20\d{2}\s*$/u (Sonar S8786); same result.
 */
export function withoutTrailingYearV1(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1]!)) end -= 1;
  if (end < 4 || !/^20\d{2}$/u.test(text.slice(end - 4, end))) return text;
  end -= 4;
  while (end > 0 && isSpace(text[end - 1]!)) end -= 1;
  while (end > 0 && '-–—_:'.includes(text[end - 1]!)) end -= 1;
  while (end > 0 && isSpace(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

export function teacherNameFromFileName(name: string): string | null {
  const withoutExtension = name.replace(/\.[^.]+$/u, '');
  const withoutPrefix = withoutExtension.replace(
    /^(?:BANCO\s+DE\s+NOTAS|CONTROLE\s+DE\s+NOTAS|NOTAS)\s*[-–—_:]*\s*/iu,
    '',
  );
  const candidate = withoutTrailingYearV1(withoutPrefix)
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return candidate.length > 0 ? candidate : null;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .trim()
    .toUpperCase();
}

function cellAt(sheet: Worksheet, address: string): Cell | undefined {
  const value = sheet[address];
  return value && typeof value === 'object' ? value : undefined;
}

function rawValueAt(sheet: Worksheet, address: string): SourceCellRawValueV1 | undefined {
  const value = cellAt(sheet, address)?.v;
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as SourceCellRawValueV1)
    : undefined;
}

/**
 * Known definition cells inside the worksheet range are observations even when
 * SheetJS omits an empty XML/XLSB cell. A real formula/error without a saved
 * scalar remains unavailable and must never be reinterpreted as deletion.
 */
function definitionRawValueAt(
  sheet: Worksheet,
  address: string,
): SourceCellRawValueV1 | undefined {
  const cell = cellAt(sheet, address);
  if (!cell) return addressWithinWorksheetRange(sheet, address) ? null : undefined;
  if (cell.t === 'e' || (cell.f && (cell.v === undefined || cell.v === null))) return undefined;
  return rawValueAt(sheet, address);
}

function a1Coordinates(address: string): { readonly row: number; readonly column: number } | null {
  const match = address.trim().match(/^\$?([A-Z]+)\$?(\d+)$/iu);
  if (!match?.[1] || !match[2]) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.codePointAt(0)! - 64;
  }
  const row = Number(match[2]);
  return Number.isInteger(row) && row > 0 ? { row, column } : null;
}

function addressWithinWorksheetRange(sheet: Worksheet, address: string): boolean {
  const reference = sheet['!ref'];
  if (!reference) return false;
  const [startReference, endReference = startReference] = reference.split(':');
  if (!startReference || !endReference) return false;
  const start = a1Coordinates(startReference);
  const end = a1Coordinates(endReference);
  const candidate = a1Coordinates(address);
  if (!start || !end || !candidate) return false;
  return (
    candidate.row >= Math.min(start.row, end.row) &&
    candidate.row <= Math.max(start.row, end.row) &&
    candidate.column >= Math.min(start.column, end.column) &&
    candidate.column <= Math.max(start.column, end.column)
  );
}

function provenance(
  fileName: string,
  fileSha256: string,
  sheetName: string,
  cellAddress: string,
): SourceCellProvenanceV1 {
  return { fileName, fileSha256, sheetName, cellAddress };
}

function textAt(sheet: Worksheet, address: string): string {
  const cell = cellAt(sheet, address);
  if (!cell) return '';
  if (typeof cell.v === 'string') return cell.v.trim();
  if (typeof cell.v === 'number') return String(cell.v);
  if (typeof cell.w === 'string') return cell.w.trim();
  return '';
}

function numberAt(sheet: Worksheet, address: string): number | null {
  const cell = cellAt(sheet, address);
  if (!cell) return null;
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return cell.v;
  if (typeof cell.v === 'string') {
    const parsed = Number(cell.v.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readNote(sheet: Worksheet, address: string): NoteValue | null {
  const cell = cellAt(sheet, address);
  if (!cell) return null;
  const source = numberAt(sheet, address);
  if (source === null) return null;

  if (cell.f) {
    if (source === 0) return null;
    return { source, value: source, kind: 'formula', formula: cell.f };
  }

  if (source === 0) return { source, value: 0, kind: 'legacy-zero' };
  if (source < 0) return { source, value: source, kind: 'negative' };
  return { source, value: source, kind: 'manual' };
}

function readResultCellObservationV4(
  sheet: Worksheet,
  address: string,
): GradebookImportResultCellObservationV4 {
  const cell = cellAt(sheet, address);
  if (!cell || (cell.v === undefined && !cell.f)) {
    return addressWithinWorksheetRange(sheet, address)
      ? { classification: 'empty', rawValue: null }
      : { classification: 'missing-field' };
  }
  const rawValue =
    cell.v === null || ['string', 'number', 'boolean'].includes(typeof cell.v)
      ? (cell.v as SourceCellRawValueV1)
      : null;

  if (cell.f) {
    if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
      return cell.v === 0
        ? { classification: 'formula-zero', rawValue, formula: cell.f, cachedValue: 0 }
        : {
            classification: 'formula-nonzero',
            rawValue,
            formula: cell.f,
            cachedValue: cell.v,
          };
    }
    return {
      classification: 'formula-error-or-missing-cache',
      rawValue,
      formula: cell.f,
      cachedValue: null,
      sourceError: errorTextOf(cell),
    };
  }

  if (cell.v === null || cell.v === '') return { classification: 'empty', rawValue: cell.v };
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
    if (cell.v === 0) return { classification: 'manual-legacy-zero', rawValue: 0 };
    if (cell.v < 0) return { classification: 'manual-negative-number', rawValue: cell.v };
    return { classification: 'manual-positive-number', rawValue: cell.v };
  }
  if (typeof cell.v === 'string') return { classification: 'invalid-text', rawValue: cell.v };
  return { classification: 'invalid-text', rawValue: scalarTextV1(cell.v) };
}

function readRecoveryApplicability(
  sheet: Worksheet,
  address: string,
): GradebookImportRecoveryApplicabilityObservationV3 {
  const cell = cellAt(sheet, address);
  if (!cell) {
    return addressWithinWorksheetRange(sheet, address)
      ? { classification: 'empty', rawValue: null }
      : { classification: 'missing-field' };
  }

  let rawValue;
  if (cell.v === null || ['string', 'number', 'boolean'].includes(typeof cell.v)) {
    rawValue = cell.v as SourceCellRawValueV1;
  } else if (typeof cell.w === 'string' && cell.w.trim()) {
    rawValue = cell.w;
  } else {
    rawValue = null;
  }
  if (cell.f) {
    return {
      classification: 'formula',
      rawValue,
      formula: cell.f,
      cachedValue: typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null,
    };
  }
  if (cell.v === undefined) {
    return addressWithinWorksheetRange(sheet, address)
      ? { classification: 'empty', rawValue: null }
      : { classification: 'missing-field' };
  }
  if (cell.v === null || cell.v === '') return { classification: 'empty', rawValue: cell.v };
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
    return { classification: 'numeric', rawValue: cell.v };
  }
  if (typeof cell.v === 'string' || typeof cell.v === 'boolean') {
    return { classification: 'unrecognized', rawValue: cell.v };
  }
  return { classification: 'unrecognized', rawValue: scalarTextV1(cell.v) };
}

function isStudentNumber(value: string): boolean {
  return /^\d+$/u.test(value.trim());
}

function stageFromToken(token: string): GradeStage {
  const normalized = token.toUpperCase().replace('°', 'º');
  if (normalized === 'VG') return 'overview';
  if (normalized === '1º') return 'trimester-1';
  if (normalized === '2º') return 'trimester-2';
  if (normalized === '3º') return 'trimester-3';
  return 'recovery';
}

export function stageLabel(stage: GradeStage): string {
  switch (stage) {
    case 'overview':
      return 'Visão geral';
    case 'trimester-1':
      return '1º trimestre';
    case 'trimester-2':
      return '2º trimestre';
    case 'trimester-3':
      return '3º trimestre';
    case 'recovery':
      return 'Recuperação final';
  }
}

function stageShortLabel(stage: GradeStage): string {
  switch (stage) {
    case 'trimester-1':
      return '1º';
    case 'trimester-2':
      return '2º';
    case 'trimester-3':
      return '3º';
    case 'recovery':
      return 'REC';
    default:
      return 'VG';
  }
}

function parseGradeSheetName(name: string): {
  className: string;
  stage: GradeStage;
  disciplineIndex: string;
} | null {
  const match = name.trim().match(/^(.*?)(VG|1[º°]|2[º°]|3[º°]|REC)\s*(D\d+)?$/iu);
  if (!match) return null;
  const className = match[1]?.trim();
  const stageToken = match[2];
  if (!className || !stageToken) return null;
  return {
    className,
    stage: stageFromToken(stageToken),
    disciplineIndex: match[3]?.toUpperCase() ?? 'D1',
  };
}

function worksheetDimensions(sheet: Worksheet, xlsx: SheetJs): Omit<SheetSummary, 'name'> {
  const range = sheet['!ref'];
  if (!range) return { range: 'Vazia', rows: 0, columns: 0 };
  const decoded = xlsx.utils.decode_range(range);
  return {
    range,
    rows: decoded.e.r - decoded.s.r + 1,
    columns: decoded.e.c - decoded.s.c + 1,
  };
}

function recognizeRecovery(sheet: Worksheet, row: number): RecoveryRecognition {
  const applicabilityTrimester1 = readRecoveryApplicability(sheet, `AC${row}`);
  const applicabilityTrimester2 = readRecoveryApplicability(sheet, `AD${row}`);
  const applicabilityTrimester3 = readRecoveryApplicability(sheet, `AE${row}`);
  return {
    trimester1: readNote(sheet, `R${row}`),
    trimester2: readNote(sheet, `S${row}`),
    trimester3: readNote(sheet, `T${row}`),
    totalAfterRecovery: readNote(sheet, `U${row}`),
    originalTrimester1: readNote(sheet, `X${row}`),
    originalTrimester2: readNote(sheet, `Y${row}`),
    originalTrimester3: readNote(sheet, `AA${row}`),
    originalAnnual: readNote(sheet, `AB${row}`),
    resultObservations: {
      trimester1: readResultCellObservationV4(sheet, `R${row}`),
      trimester2: readResultCellObservationV4(sheet, `S${row}`),
      trimester3: readResultCellObservationV4(sheet, `T${row}`),
      totalAfterRecovery: readResultCellObservationV4(sheet, `U${row}`),
      originalTrimester1: readResultCellObservationV4(sheet, `X${row}`),
      originalTrimester2: readResultCellObservationV4(sheet, `Y${row}`),
      originalTrimester3: readResultCellObservationV4(sheet, `AA${row}`),
      originalAnnual: readResultCellObservationV4(sheet, `AB${row}`),
    },
    applicabilityTrimester1,
    applicabilityTrimester2,
    applicabilityTrimester3,
    eligibleTrimester1:
      applicabilityTrimester1.classification === 'numeric' &&
      applicabilityTrimester1.rawValue === 1,
    eligibleTrimester2:
      applicabilityTrimester2.classification === 'numeric' &&
      applicabilityTrimester2.rawValue === 1,
    eligibleTrimester3:
      applicabilityTrimester3.classification === 'numeric' &&
      applicabilityTrimester3.rawValue === 1,
  };
}

function recognizeAssessmentDefinitions(
  fileName: string,
  fileSha256: string,
  sheetName: string,
  sheet: Worksheet,
  stage: GradeStage,
): readonly SourceAssessmentDefinitionV2[] {
  if (stage !== 'trimester-1' && stage !== 'trimester-2' && stage !== 'trimester-3') return [];

  const quantitative = SOURCE_QUANTITATIVE_ASSESSMENT_SLOTS_V2.map((slot) => ({
    contractVersion: SOURCE_CONTRACT_VERSION_V2,
    kind: 'quantitative-assessment' as const,
    sourceSlot: slot.sourceSlot,
    order: slot.order,
    structuralLabel: slot.structuralLabel,
    maximumConfiguration: classifySourceAssessmentMaximumConfigurationV2(
      definitionRawValueAt(sheet, slot.maximumCell),
      provenance(fileName, fileSha256, sheetName, slot.maximumCell),
    ),
  }));

  const qualitative = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => ({
    contractVersion: SOURCE_CONTRACT_VERSION_V2,
    kind: 'qualitative-activity' as const,
    sourceSlot: slot.sourceSlot,
    order: slot.order,
    maximumConfiguration: classifySourceAssessmentMaximumConfigurationV2(
      definitionRawValueAt(sheet, slot.maximumCell),
      provenance(fileName, fileSha256, sheetName, slot.maximumCell),
    ),
    name: classifySourceAssessmentNameV2(
      definitionRawValueAt(sheet, slot.nameCell),
      provenance(fileName, fileSha256, sheetName, slot.nameCell),
    ),
  }));

  return [...quantitative, ...qualitative];
}

function recognizeStudents(
  sheet: Worksheet,
  stage: GradeStage,
  xlsx: SheetJs,
): StudentRecognition[] {
  const range = sheet['!ref'];
  if (!range) return [];
  const decoded = xlsx.utils.decode_range(range);
  const startRow = Math.max(5, decoded.s.r + 1);
  const endRow = decoded.e.r + 1;
  const readGrades = stage === 'trimester-1' || stage === 'trimester-2' || stage === 'trimester-3';
  const readRecovery = stage === 'recovery';
  const students: StudentRecognition[] = [];

  for (let row = startRow; row <= endRow; row += 1) {
    const number = textAt(sheet, `J${row}`);
    const name = textAt(sheet, `K${row}`);
    if (!name || !isStudentNumber(number)) continue;

    students.push({
      row,
      number,
      name,
      status: textAt(sheet, `G${row}`),
      quantitativeAssessments: readGrades
        ? [readNote(sheet, `R${row}`), readNote(sheet, `S${row}`)]
        : [null, null],
      quantitativeTotal: readGrades ? readNote(sheet, `T${row}`) : null,
      parallel: readGrades ? readNote(sheet, `Z${row}`) : null,
      qualitative: readGrades
        ? SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) =>
            readNote(sheet, `${slot.studentValueColumn}${row}`),
          )
        : [],
      qualitativeTotal: readGrades ? readNote(sheet, `AK${row}`) : null,
      official: readGrades ? readNote(sheet, `AM${row}`) : null,
      annual: readGrades ? readNote(sheet, `AN${row}`) : null,
      termResultObservations: readGrades
        ? {
            quantitativeTotal: readResultCellObservationV4(sheet, `T${row}`),
            parallelAssessment: readResultCellObservationV4(sheet, `Z${row}`),
            qualitativeTotal: readResultCellObservationV4(sheet, `AK${row}`),
            officialTermGrade: readResultCellObservationV4(sheet, `AM${row}`),
            annualAccumulatedTotal: readResultCellObservationV4(sheet, `AN${row}`),
          }
        : null,
      recovery: readRecovery ? recognizeRecovery(sheet, row) : null,
    });
  }

  return students;
}

function recognitionValues(student: StudentRecognition): Array<NoteValue | null> {
  const values: Array<NoteValue | null> = [
    ...student.quantitativeAssessments,
    student.quantitativeTotal,
    student.parallel,
    ...student.qualitative,
    student.qualitativeTotal,
    student.official,
    student.annual,
  ];

  if (student.recovery) {
    values.push(
      student.recovery.trimester1,
      student.recovery.trimester2,
      student.recovery.trimester3,
      student.recovery.totalAfterRecovery,
      student.recovery.originalTrimester1,
      student.recovery.originalTrimester2,
      student.recovery.originalTrimester3,
      student.recovery.originalAnnual,
    );
  }

  return values;
}

function recognizeGradeSheet(
  fileName: string,
  fileSha256: string,
  name: string,
  sheet: Worksheet,
  xlsx: SheetJs,
): GradeSheetRecognition | null {
  const pattern = parseGradeSheetName(name);
  if (!pattern) return null;

  const dimensions = worksheetDimensions(sheet, xlsx);
  const className = textAt(sheet, 'K3') || pattern.className;
  const discipline = textAt(sheet, 'K2');
  const declaredStage = textAt(sheet, 'K4');
  const declaredStudentsValue = numberAt(sheet, 'J1');
  const assessmentDefinitions = recognizeAssessmentDefinitions(
    fileName,
    fileSha256,
    name,
    sheet,
    pattern.stage,
  );
  const students = recognizeStudents(sheet, pattern.stage, xlsx);
  let formulas = 0;
  let officialZeros = 0;

  for (const student of students) {
    for (const value of recognitionValues(student)) {
      if (value?.kind === 'formula') formulas += 1;
      if (value?.kind === 'official-zero') officialZeros += 1;
    }
  }

  return {
    name,
    range: dimensions.range,
    rows: dimensions.rows,
    columns: dimensions.columns,
    className,
    discipline,
    disciplineIndex: pattern.disciplineIndex,
    stage: pattern.stage,
    declaredStage,
    declaredStudents:
      declaredStudentsValue !== null && declaredStudentsValue >= 0
        ? Math.round(declaredStudentsValue)
        : null,
    assessmentDefinitions,
    students,
    formulas,
    officialZeros,
  };
}

function buildClasses(gradeSheets: GradeSheetRecognition[]): ClassRecognition[] {
  const grouped = new Map<
    string,
    {
      displayName: string;
      students: Set<string>;
      declared: number[];
      disciplines: Set<string>;
      trimesters: Set<string>;
      recovery: boolean;
      sheets: GradeSheetRecognition[];
    }
  >();

  for (const sheet of gradeSheets) {
    if (sheet.stage === 'overview') continue;
    const key = normalizeText(sheet.className);
    if (!key) continue;
    const current = grouped.get(key) ?? {
      displayName: sheet.className,
      students: new Set<string>(),
      declared: [],
      disciplines: new Set<string>(),
      trimesters: new Set<string>(),
      recovery: false,
      sheets: [],
    };

    if (
      sheet.stage === 'trimester-1' ||
      sheet.stage === 'trimester-2' ||
      sheet.stage === 'trimester-3'
    ) {
      for (const student of sheet.students) {
        current.students.add(`${student.number}|${normalizeText(student.name)}`);
      }
    }
    if (sheet.declaredStudents !== null) current.declared.push(sheet.declaredStudents);
    if (sheet.discipline) current.disciplines.add(sheet.discipline);
    if (
      sheet.stage === 'trimester-1' ||
      sheet.stage === 'trimester-2' ||
      sheet.stage === 'trimester-3'
    ) {
      current.trimesters.add(stageShortLabel(sheet.stage));
    }
    if (sheet.stage === 'recovery') current.recovery = true;
    current.sheets.push(sheet);
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((group) => ({
      name: group.displayName,
      students: group.students.size,
      declaredStudents: group.declared.length > 0 ? Math.max(...group.declared) : null,
      disciplines: [...group.disciplines].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      trimesters: [...group.trimesters].sort(comparePtBrNumericLabelsV1),
      recovery: group.recovery,
      sheets: group.sheets.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
}

export function recognizeWorkbook(
  file: File,
  workbook: Workbook,
  xlsx: SheetJs,
  source: WorkbookRecognitionSourceV2,
): WorkbookSummary {
  const sheets = workbook.SheetNames.map((name) => {
    const dimensions = worksheetDimensions(workbook.Sheets[name] ?? {}, xlsx);
    return { ...dimensions, name };
  });

  const gradeSheets = workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return [];
    const recognized = recognizeGradeSheet(file.name, source.fileSha256, name, sheet, xlsx);
    if (recognized && source.captureValues) {
      const cells: Record<
        string,
        | import('../../../../shared/gradebook-contracts/imports/import-persistence-transport-v8').GradebookSnapshotCellV8
        | null
      > = {};
      const columns =
        recognized.stage === 'recovery'
          ? ['R', 'S', 'T', 'U', 'X', 'Y', 'AA', 'AB', 'AC', 'AD', 'AE']
          : [
              'R',
              'S',
              'T',
              'Z',
              'AA',
              'AB',
              'AC',
              'AD',
              'AE',
              'AF',
              'AG',
              'AH',
              'AI',
              'AJ',
              'AK',
              'AM',
              'AN',
            ];
      const granularColumns = new Set([
        'R',
        'S',
        'Z',
        ...SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.map((slot) => slot.sourceSlot),
      ]);
      for (const student of recognized.students)
        for (const col of columns) {
          const addr = `${col}${student.row}`;
          const cell = cellAt(sheet, addr);
          const value = snapshotRawCellV8(cell);
          // Excel may omit an empty cell entirely. The sheet and student row were read,
          // so this is an observed blank, not an unavailable source/cache.
          if (recognized.stage.startsWith('trimester-') && granularColumns.has(col))
            cells[addr] = value ?? null;
          else if (value !== undefined) cells[addr] = value;
        }
      recognized.snapshotCellsV8 = cells;
    }
    return recognized ? [recognized] : [];
  });
  const recognizedNames = new Set(gradeSheets.map((sheet) => sheet.name));
  const auxiliarySheets = workbook.SheetNames.filter((name) =>
    ['RELACAO', 'CONFIGURACAO', 'INICIO'].includes(normalizeText(name)),
  );
  const auxiliaryNames = new Set(auxiliarySheets);
  const configurationName = auxiliarySheets.find((name) => normalizeText(name) === 'CONFIGURACAO');
  const configuredYear = configurationName
    ? numberAt(workbook.Sheets[configurationName] ?? {}, 'C2')
    : null;
  const configuredTeacherName = configurationName
    ? textAt(workbook.Sheets[configurationName] ?? {}, 'A2')
    : '';
  const academicYear =
    configuredYear !== null &&
    Number.isSafeInteger(configuredYear) &&
    configuredYear >= 2000 &&
    configuredYear <= 9999
      ? configuredYear
      : null;

  return {
    fileName: file.name,
    format: fileExtension(file.name).toUpperCase(),
    size: file.size,
    parserVersion: xlsx.version,
    academicYear,
    teacherName:
      configuredTeacherName.length > 0 ? configuredTeacherName : teacherNameFromFileName(file.name),
    sheets,
    gradeSheets,
    classes: buildClasses(gradeSheets),
    auxiliarySheets,
    unrecognizedSheets: workbook.SheetNames.filter(
      (name) => !recognizedNames.has(name) && !auxiliaryNames.has(name),
    ),
  };
}

export function formatNote(note: NoteValue | null): string {
  if (!note) return '—';
  const formatted = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(note.value);
  return note.kind === 'official-zero' ? `${formatted} (0,1)` : formatted;
}

export function noteCount(values: Array<NoteValue | null>): number {
  return values.filter(Boolean).length;
}

export function trimesterSheets(sheets: GradeSheetRecognition[]): GradeSheetRecognition[] {
  return sheets.filter(
    (sheet) =>
      sheet.stage === 'trimester-1' ||
      sheet.stage === 'trimester-2' ||
      sheet.stage === 'trimester-3',
  );
}

export function recoverySheets(sheets: GradeSheetRecognition[]): GradeSheetRecognition[] {
  return sheets.filter((sheet) => sheet.stage === 'recovery');
}
