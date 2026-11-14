import { SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2 } from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type { GradebookImportDiagnosticCodeV1 } from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type { GradeSheetRecognition, StudentRecognition, WorkbookSummary } from './spreadsheet-recognizer';

/**
 * Audit rules of BN-DEC-046. One pass over what the reader already extracted returns, together,
 * the problems shown in the Auditoria and what the canonical builder holds back: the Auditoria
 * shows exactly what was not written. Nothing here corrects data; a new import does.
 */
export type AuditFindingV1 = {
  readonly code: GradebookImportDiagnosticCodeV1;
  readonly blocking: boolean;
  readonly sheet: GradeSheetRecognition;
  readonly student?: StudentRecognition;
  readonly row?: number;
  readonly slot?: number;
  readonly cellAddress?: string;
  readonly foundValue?: string;
  readonly cause?: string;
};

export type AuditHoldsV1 = {
  /** Qualitative slots (11–20) held for the whole sheet. */
  readonly columns: ReadonlyMap<string, ReadonlySet<number>>;
  /** Rows whose term result (AM) is held. */
  readonly results: ReadonlyMap<string, ReadonlySet<number>>;
  /** Rows whose qualitative activities are held. */
  readonly qualitativeRows: ReadonlyMap<string, ReadonlySet<number>>;
  /** Recovery cells (R/S/T) held, by address. */
  readonly recoveryCells: ReadonlyMap<string, ReadonlySet<string>>;
  /** Sheets whose class/subject is held as a whole. */
  readonly offers: ReadonlyMap<string, string>;
};

export type AuditOutcomeV1 = { readonly findings: readonly AuditFindingV1[]; readonly holds: AuditHoldsV1 };

export const EMPTY_HOLDS_V1: AuditHoldsV1 = {
  columns: new Map(), results: new Map(), qualitativeRows: new Map(), recoveryCells: new Map(), offers: new Map(),
};

function add<T>(map: Map<string, Set<T>>, key: string, value: T): void {
  const set = map.get(key) ?? new Set<T>();
  set.add(value);
  map.set(key, set);
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/gu, '').toUpperCase().replace(/\s+/gu, ' ').trim();
}

function snapshotNumber(sheet: GradeSheetRecognition, address: string): number | null {
  const raw = sheet.snapshotCellsV8?.[address];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^[+-]?\d+(?:[.,]\d+)?$/u.test(raw.trim())) return Number(raw.trim().replace(',', '.'));
  return null;
}

function hasValue(sheet: GradeSheetRecognition, address: string): boolean {
  const raw = sheet.snapshotCellsV8?.[address];
  if (raw === undefined || raw === null || Array.isArray(raw)) return false;
  return !(typeof raw === 'string' && raw.trim() === '');
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** "6A", "6º ANO A", "6 A" → "6A"; null when the text has no class code. */
function classCode(value: string): string | null {
  const match = /(\d{1,2})\D*?([A-Z])\b/u.exec(normalized(value).replace(/\bANO\b/gu, ''));
  return match ? `${match[1]}${match[2]}` : null;
}

const TERM_DIGITS_V1: Readonly<Record<string, number>> = { 1: 1, 2: 2, 3: 3 };
const ORDINAL_MARKS_V1 = new Set(['º', '°', 'O']);
const isSpaceV1 = (char: string | undefined) => char !== undefined && /\s/u.test(char);
const isWordCharV1 = (char: string | undefined) => char !== undefined && /\w/u.test(char);

/**
 * The term named right before "TRIM" at `at`: "I", "II", "III" or 1–3, optionally followed by an
 * ordinal mark and spaces, starting at a word boundary. Same reading as the former expression
 * /\b(I{1,3}|[123])\s*[º°O]?\s*TRIM/, scanned backwards in linear time.
 */
function termBeforeV1(text: string, at: number): number | null {
  let index = at;
  while (isSpaceV1(text[index - 1])) index -= 1;
  if (ORDINAL_MARKS_V1.has(text[index - 1] ?? '')) {
    index -= 1;
    while (isSpaceV1(text[index - 1])) index -= 1;
  }
  const digit = TERM_DIGITS_V1[text[index - 1] ?? ''];
  if (digit !== undefined) return isWordCharV1(text[index - 2]) ? null : digit;
  let numeral = 0;
  while (text[index - 1 - numeral] === 'I') numeral += 1;
  if (numeral === 0 || numeral > 3 || isWordCharV1(text[index - 1 - numeral])) return null;
  return numeral;
}

/** "II TRIMESTRE" → 2; null when K4 does not name a term. */
export function declaredTermV1(value: string): number | null {
  const text = normalized(value);
  for (let at = text.indexOf('TRIM'); at >= 0; at = text.indexOf('TRIM', at + 1)) {
    const term = termBeforeV1(text, at);
    if (term !== null) return term;
  }
  return null;
}

function termOf(sheet: GradeSheetRecognition): 1 | 2 | 3 | null {
  if (sheet.stage === 'trimester-1') return 1;
  if (sheet.stage === 'trimester-2') return 2;
  if (sheet.stage === 'trimester-3') return 3;
  return null;
}

function offerKey(sheet: GradeSheetRecognition): string {
  return JSON.stringify([normalized(sheet.className), normalized(sheet.discipline), sheet.disciplineIndex.trim().toUpperCase()]);
}

/** Why a graded activity column cannot be launched: no maximum, or no description; null when it can. */
function unlaunchableColumnCodeV1(maximum: number | null, definition: GradeSheetRecognition['assessmentDefinitions'][number] | undefined) {
  if (maximum === null) return 'activity-without-maximum' as const;
  return described(definition) ? null : 'activity-without-description' as const;
}

const MANUAL_RESULT_V1 = new Set(['manual-positive-number', 'manual-negative-number', 'manual-official-zero-marker']);

function described(definition: GradeSheetRecognition['assessmentDefinitions'][number] | undefined): boolean {
  if (definition?.kind !== 'qualitative-activity') return false;
  const name = definition.name;
  return name.state === 'text' && name.rawValue.trim().length > 0 && name.rawValue.trim() !== String(definition.order);
}

function validMaximum(definition: GradeSheetRecognition['assessmentDefinitions'][number] | undefined): number | null {
  const configuration = definition?.maximumConfiguration;
  return configuration?.state === 'numeric' && positive(configuration.rawValue) ? configuration.rawValue : null;
}

type TermHoldsV1 = {
  columns: Map<string, Set<number>>; results: Map<string, Set<number>>; qualitativeRows: Map<string, Set<number>>;
  offers: Map<string, string>;
};

/** What every rule of one term sheet shares. */
type TermAuditV1 = {
  readonly sheet: GradeSheetRecognition;
  readonly findings: AuditFindingV1[];
  readonly holds: TermHoldsV1;
  readonly holdResult: (row: number) => void;
};

/** 7. Header K3/K4 different from the sheet name: the whole class/subject is held. */
function auditTermHeaderV1({ sheet, findings, holds }: TermAuditV1): void {
  const expectedTerm = termOf(sheet);
  const k4 = declaredTermV1(sheet.declaredStage);
  const k3 = classCode(sheet.className);
  const named = sheet.auditV1 ? classCode(sheet.auditV1.sheetClass) : null;
  const termDiffers = k4 !== null && expectedTerm !== null && k4 !== expectedTerm;
  const classDiffers = k3 !== null && named !== null && k3 !== named;
  if (!termDiffers && !classDiffers) return;
  holds.offers.set(sheet.name, `Cabeçalho de ${sheet.name} não corresponde à guia.`);
  const k4Cell = k4 !== expectedTerm;
  findings.push({ code: 'header-mismatch', blocking: true, sheet, cellAddress: k4Cell ? 'K4' : 'K3',
    foundValue: k4Cell ? sheet.declaredStage : sheet.className });
}

/** 1 and 2. Grades in an activity column without description or without a valid maximum; returns the maxima's sum. */
function auditActivityColumnsV1({ sheet, findings, holds, holdResult }: TermAuditV1): number {
  const bySlot = new Map(sheet.assessmentDefinitions.map((definition) => [definition.sourceSlot, definition]));
  let maximaSum = 0;
  for (const [index, source] of SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.entries()) {
    const slot = 11 + index;
    const definition = bySlot.get(source.sourceSlot);
    const maximum = validMaximum(definition);
    if (maximum !== null) maximaSum += maximum;
    const graded = sheet.students.filter((student) => hasValue(sheet, `${source.studentValueColumn}${student.row}`));
    const code = graded.length === 0 ? null : unlaunchableColumnCodeV1(maximum, definition);
    if (!code) continue;
    add(holds.columns, sheet.name, slot);
    for (const student of graded) holdResult(student.row);
    findings.push({ code, blocking: true, sheet, slot, cellAddress: maximum === null ? source.maximumCell : source.nameCell,
      cause: `${graded.length} aluno(s) com nota nesta coluna.` });
  }
  return maximaSum;
}

/** What the per-student rules of one sheet read once. */
type StudentRulesV1 = {
  readonly ceiling: number | null;
  readonly oneAssessment: boolean;
  readonly resultsAreFormulas: boolean;
  readonly workRows: ReadonlySet<number>;
  readonly workOff: boolean;
};

/** 4. The student's activities add up to more than the qualitative ceiling. */
function auditQualitativeSumV1({ sheet, findings, holds, holdResult }: TermAuditV1, rules: StudentRulesV1,
  student: StudentRecognition): void {
  if (!positive(rules.ceiling)) return;
  const sum = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.reduce(
    (total, source) => total + (snapshotNumber(sheet, `${source.studentValueColumn}${student.row}`) ?? 0), 0);
  if (sum <= rules.ceiling + 1e-9) return;
  add(holds.qualitativeRows, sheet.name, student.row);
  holdResult(student.row);
  findings.push({ code: 'qualitative-over-ceiling', blocking: true, sheet, student, cellAddress: `AA${student.row}:AJ${student.row}`,
    foundValue: String(Math.round(sum * 1000) / 1000), cause: `Teto qualitativo: ${rules.ceiling}.` });
}

/** 9, 11 and 12: a work grade with the block off, AV2 in one-assessment mode, a typed term result. */
function auditStudentEntriesV1({ sheet, findings, holdResult }: TermAuditV1, rules: StudentRulesV1,
  student: StudentRecognition): void {
  if (rules.workOff && rules.workRows.has(student.row)) {
    holdResult(student.row);
    findings.push({ code: 'work-without-weight', blocking: true, sheet, student, cellAddress: `U${student.row}:X${student.row}` });
  }
  if (rules.oneAssessment && hasValue(sheet, `S${student.row}`)) {
    holdResult(student.row);
    findings.push({ code: 'one-assessment-mode', blocking: true, sheet, student, cellAddress: `S${student.row}` });
  }
  const result = student.termResultObservations?.officialTermGrade;
  if (rules.resultsAreFormulas && result && MANUAL_RESULT_V1.has(result.classification)) {
    holdResult(student.row);
    findings.push({ code: 'manual-term-result', blocking: true, sheet, student, cellAddress: `AM${student.row}`,
      foundValue: 'rawValue' in result ? String(result.rawValue) : undefined });
  }
}

function auditTermSheet(sheet: GradeSheetRecognition, findings: AuditFindingV1[], holds: TermHoldsV1): void {
  const facts = sheet.auditV1;
  const audit: TermAuditV1 = { sheet, findings, holds, holdResult: (row) => add(holds.results, sheet.name, row) };
  auditTermHeaderV1(audit);
  const maximaSum = auditActivityColumnsV1(audit);

  // 6. The activities' maxima add up to more than the qualitative ceiling: the teacher's
  // distribution is wrong, so every AM of the sheet is held until the spreadsheet is fixed.
  const ceiling = facts?.qualitativeCeiling ?? null;
  if (positive(ceiling) && maximaSum > ceiling + 1e-9) {
    for (const student of sheet.students) audit.holdResult(student.row);
    findings.push({ code: 'qualitative-maxima-over-ceiling', blocking: true, sheet, cellAddress: 'AK3',
      foundValue: String(maximaSum), cause: `Teto qualitativo: ${ceiling}.` });
  }

  const rules: StudentRulesV1 = {
    ceiling,
    oneAssessment: normalized(facts?.assessmentMode ?? '').startsWith('1 AVALIA'),
    // A typed AM is a deleted formula only where the sheet's other AMs are formulas.
    resultsAreFormulas: sheet.students.some((student) =>
      student.termResultObservations?.officialTermGrade.classification.startsWith('formula')),
    workRows: new Set(facts?.workRows ?? []),
    workOff: !positive(facts?.workCeiling ?? null),
  };
  for (const student of sheet.students) {
    auditQualitativeSumV1(audit, rules, student);
    auditStudentEntriesV1(audit, rules, student);
  }
}

/** 8. A final recovery grade above that term's maximum (T3 + Y3 + AK3 of the term sheet). */
function auditRecoverySheet(sheet: GradeSheetRecognition, terms: ReadonlyMap<number, GradeSheetRecognition>,
  findings: AuditFindingV1[], recoveryCells: Map<string, Set<string>>): void {
  const columns = [['R', 1], ['S', 2], ['T', 3]] as const;
  for (const [column, term] of columns) {
    const facts = terms.get(term)?.auditV1;
    if (!facts) continue;
    const maximum = (facts.quantitativeCeiling ?? 0) + (facts.workCeiling ?? 0) + (facts.qualitativeCeiling ?? 0);
    if (!positive(maximum)) continue;
    for (const student of sheet.students) {
      const address = `${column}${student.row}`;
      const value = snapshotNumber(sheet, address);
      if (value === null || value <= maximum + 1e-9) continue;
      add(recoveryCells, sheet.name, address);
      findings.push({ code: 'recovery-above-maximum', blocking: true, sheet, student, cellAddress: address,
        foundValue: String(value), cause: `Máximo do ${term}º trimestre: ${maximum}.` });
    }
  }
}

export function auditWorkbookV1(summary: WorkbookSummary): AuditOutcomeV1 {
  if (summary.gradeSheets.length === 0) return { findings: [], holds: EMPTY_HOLDS_V1 };
  const findings: AuditFindingV1[] = [];
  const holds = {
    columns: new Map<string, Set<number>>(), results: new Map<string, Set<number>>(),
    qualitativeRows: new Map<string, Set<number>>(), recoveryCells: new Map<string, Set<string>>(),
    offers: new Map<string, string>(),
  };
  const termsByOffer = new Map<string, Map<number, GradeSheetRecognition>>();
  for (const sheet of summary.gradeSheets) {
    const term = termOf(sheet);
    if (term === null) continue;
    auditTermSheet(sheet, findings, holds);
    const terms = termsByOffer.get(offerKey(sheet)) ?? new Map<number, GradeSheetRecognition>();
    terms.set(term, sheet);
    termsByOffer.set(offerKey(sheet), terms);
  }
  for (const sheet of summary.gradeSheets) {
    if (sheet.stage === 'recovery') auditRecoverySheet(sheet, termsByOffer.get(offerKey(sheet)) ?? new Map(), findings, holds.recoveryCells);
    // 10. A grade typed in a row without student number or name: it reaches no one.
    for (const row of sheet.auditV1?.orphanRows ?? [])
      findings.push({ code: 'grade-without-student', blocking: false, sheet, row, cellAddress: `J${row}` });
  }
  return { findings, holds };
}
