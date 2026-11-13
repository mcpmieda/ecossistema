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

/** "II TRIMESTRE" → 2; null when K4 does not name a term. */
function declaredTerm(value: string): number | null {
  const match = /\b(III|II|I|[123])\s*(?:º|°|O)?\s*TRIM/u.exec(normalized(value));
  if (!match) return null;
  return ({ I: 1, II: 2, III: 3, 1: 1, 2: 2, 3: 3 } as Record<string, number>)[match[1]!] ?? null;
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

const MANUAL_RESULT_V1 = new Set(['manual-positive-number', 'manual-negative-number', 'manual-official-zero-marker']);

function described(definition: GradeSheetRecognition['assessmentDefinitions'][number] | undefined): boolean {
  if (!definition || definition.kind !== 'qualitative-activity') return false;
  const name = definition.name;
  return name.state === 'text' && name.rawValue.trim().length > 0 && name.rawValue.trim() !== String(definition.order);
}

function validMaximum(definition: GradeSheetRecognition['assessmentDefinitions'][number] | undefined): number | null {
  const configuration = definition?.maximumConfiguration;
  return configuration?.state === 'numeric' && positive(configuration.rawValue) ? configuration.rawValue : null;
}

function auditTermSheet(sheet: GradeSheetRecognition, findings: AuditFindingV1[], holds: {
  columns: Map<string, Set<number>>; results: Map<string, Set<number>>; qualitativeRows: Map<string, Set<number>>;
  offers: Map<string, string>;
}): void {
  const facts = sheet.auditV1;
  const bySlot = new Map(sheet.assessmentDefinitions.map((definition) => [definition.sourceSlot, definition]));
  const holdResult = (row: number) => add(holds.results, sheet.name, row);

  // 7. Header K3/K4 different from the sheet name: the whole class/subject is held.
  const expectedTerm = termOf(sheet);
  const k4 = declaredTerm(sheet.declaredStage);
  const k3 = classCode(sheet.className);
  const named = facts ? classCode(facts.sheetClass) : null;
  if ((k4 !== null && expectedTerm !== null && k4 !== expectedTerm) || (k3 !== null && named !== null && k3 !== named)) {
    holds.offers.set(sheet.name, `Cabeçalho de ${sheet.name} não corresponde à guia.`);
    findings.push({ code: 'header-mismatch', blocking: true, sheet, cellAddress: k4 !== expectedTerm ? 'K4' : 'K3',
      foundValue: k4 !== expectedTerm ? sheet.declaredStage : sheet.className });
  }

  // 1 and 2. Grades in an activity column without description or without a valid maximum.
  let maximaSum = 0;
  for (const [index, source] of SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.entries()) {
    const slot = 11 + index;
    const definition = bySlot.get(source.sourceSlot);
    const maximum = validMaximum(definition);
    if (maximum !== null) maximaSum += maximum;
    const graded = sheet.students.filter((student) => hasValue(sheet, `${source.studentValueColumn}${student.row}`));
    if (graded.length === 0) continue;
    const code = maximum === null ? 'activity-without-maximum' : !described(definition) ? 'activity-without-description' : null;
    if (!code) continue;
    add(holds.columns, sheet.name, slot);
    for (const student of graded) holdResult(student.row);
    findings.push({ code, blocking: true, sheet, slot, cellAddress: maximum === null ? source.maximumCell : source.nameCell,
      cause: `${graded.length} aluno(s) com nota nesta coluna.` });
  }

  // 6. The activities' maxima add up to more than the qualitative ceiling: every AM is held.
  const ceiling = facts?.qualitativeCeiling ?? null;
  if (positive(ceiling) && maximaSum > ceiling + 1e-9) {
    for (const student of sheet.students) holdResult(student.row);
    findings.push({ code: 'qualitative-maxima-over-ceiling', blocking: true, sheet, cellAddress: 'AK3',
      foundValue: String(maximaSum), cause: `Teto qualitativo: ${ceiling}.` });
  }

  const oneAssessment = normalized(facts?.assessmentMode ?? '').startsWith('1 AVALIA');
  const workRows = new Set(facts?.workRows ?? []);
  const workOff = !positive(facts?.workCeiling ?? null);
  for (const student of sheet.students) {
    // 4. The student's activities add up to more than the qualitative ceiling.
    if (positive(ceiling)) {
      const sum = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.reduce(
        (total, source) => total + (snapshotNumber(sheet, `${source.studentValueColumn}${student.row}`) ?? 0), 0);
      if (sum > ceiling + 1e-9) {
        add(holds.qualitativeRows, sheet.name, student.row);
        holdResult(student.row);
        findings.push({ code: 'qualitative-over-ceiling', blocking: true, sheet, student, cellAddress: `AA${student.row}:AJ${student.row}`,
          foundValue: String(Math.round(sum * 1000) / 1000), cause: `Teto qualitativo: ${ceiling}.` });
      }
    }
    // 9. A work grade (U:X) while the work block is off: the formula drops it.
    if (workOff && workRows.has(student.row)) {
      holdResult(student.row);
      findings.push({ code: 'work-without-weight', blocking: true, sheet, student, cellAddress: `U${student.row}:X${student.row}` });
    }
    // 11. AV2 filled while the sheet is in "1 AVALIAÇÃO" mode.
    if (oneAssessment && hasValue(sheet, `S${student.row}`)) {
      holdResult(student.row);
      findings.push({ code: 'one-assessment-mode', blocking: true, sheet, student, cellAddress: `S${student.row}` });
    }
    // 12. The term result typed by hand instead of the sheet's formula.
    const result = student.termResultObservations?.officialTermGrade;
    if (result && MANUAL_RESULT_V1.has(result.classification)) {
      holdResult(student.row);
      findings.push({ code: 'manual-term-result', blocking: true, sheet, student, cellAddress: `AM${student.row}`,
        foundValue: 'rawValue' in result ? String(result.rawValue) : undefined });
    }
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
