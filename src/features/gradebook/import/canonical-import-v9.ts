import {
  isGradebookImportPersistenceRequestV9,
  type GradebookImportCellV9,
  type GradebookImportInstrumentV9,
  type GradebookImportOfferV9,
  type GradebookImportPersistenceRequestV9,
  type GradebookImportRecoveryCellV9,
  type GradebookImportTermV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import { isGradebookAcademicYearV2 } from '../../../../shared/gradebook-contracts/academic-year-v2';
import {
  SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2,
  type SourceAssessmentDefinitionV2,
} from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type { GradebookImportResultCellObservationV4 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v4';
import type { BatchSuccess } from './import-batch';
import type {
  GradeSheetRecognition,
  StudentRecognition,
  WorkbookSummary,
} from './spreadsheet-recognizer';
import type { MasterRelationRecognitionV9 } from './master-relation-v9';
import { EMPTY_HOLDS_V1, auditWorkbookV1, type AuditHoldsV1 } from './audit-rules-v1';

type CanonicalImportProgressStageV9 = 'roster' | 'grades' | 'recovery' | 'compacting';
interface CanonicalImportProgressV9 {
  readonly stage: CanonicalImportProgressStageV9;
  readonly current: number;
  readonly total: number;
}

export interface CanonicalImportWarningV9 {
  readonly code: 'above-maximum';
  readonly sheetName: string;
  readonly cellAddress: string;
  readonly value: number;
  readonly maximum: number;
}

/**
 * Partial hold (BN-DEC-045): a problem holds only what it affects. A held cell travels as
 * unavailable (`['u']`), so the database keeps its last good value; the student's term result
 * (AM) or final result (U) computed from it is held too. A problem that makes a whole
 * class/subject unreadable (duplicate number, invalid AV1/AV2 maximum, missing term…) holds
 * that offer, which is left out and stays as it is. Everything else is written.
 */
export type CanonicalImportHeldV9 =
  | {
      readonly kind: 'cell';
      readonly sheetName: string;
      readonly cellAddress: string;
      readonly reason: 'invalid-cell' | 'depends-on-held-cell';
    }
  | { readonly kind: 'offer'; readonly sheetNames: readonly string[]; readonly reason: string };

interface CanonicalImportRuntimeV9 {
  readonly onProgress?: (progress: CanonicalImportProgressV9) => void;
  readonly onWarning?: (warning: CanonicalImportWarningV9) => void;
  readonly onHeld?: (held: CanonicalImportHeldV9) => void;
}

const HELD_CELL_V9: readonly ['u'] = ['u'];

/** Reads one cell; a value the import cannot accept is held instead of stopping the file. */
function holdableCellV9<T>(
  runtime: CanonicalImportRuntimeV9,
  sheet: GradeSheetRecognition,
  address: string,
  read: () => T,
): { readonly value: T | readonly ['u']; readonly held: boolean } {
  try {
    return { value: read(), held: false };
  } catch {
    runtime.onHeld?.({ kind: 'cell', sheetName: sheet.name, cellAddress: address, reason: 'invalid-cell' });
    return { value: HELD_CELL_V9, held: true };
  }
}

function heldResultV9(
  runtime: CanonicalImportRuntimeV9,
  sheet: GradeSheetRecognition,
  address: string,
): readonly ['u'] {
  runtime.onHeld?.({ kind: 'cell', sheetName: sheet.name, cellAddress: address, reason: 'depends-on-held-cell' });
  return HELD_CELL_V9;
}

type SummaryWithRelationV9 = WorkbookSummary & {
  readonly masterRelationV9?: MasterRelationRecognitionV9;
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .trim()
    .replaceAll(/\s+/gu, ' ')
    .toUpperCase();
}

function parserVersion(value: string): string {
  return `${value.slice(0, 48)}:canonical-v9:observed-blanks-v1:decimal-grades-v1:definition-snapshot-v1`;
}

function manifest(result: BatchSuccess) {
  return {
    fileName: result.manifest.fileName,
    sha256: result.manifest.sha256,
    parserVersion: parserVersion(result.manifest.parserVersion),
  } as const;
}

/** Converts a decimal spreadsheet number to exact academic thousandths. The tolerance only absorbs IEEE-754 representation noise. */
export function canonicalMilliV9(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Valor numérico inválido: ${String(value)}.`);
  const scaled = value * 1000;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw new Error(`Valor ${String(value)} exige mais de 3 casas decimais.`);
  }
  return rounded;
}

function snapshot(sheet: GradeSheetRecognition, address: string): unknown {
  return sheet.snapshotCellsV8?.[address];
}

function cellFromSnapshot(
  sheet: GradeSheetRecognition,
  address: string,
): GradebookImportCellV9 {
  const raw = snapshot(sheet, address);
  if (Array.isArray(raw)) return ['u'];
  if (raw === undefined) return ['u'];
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw === 'boolean')
    throw new Error(`Texto/valor inválido em ${sheet.name}!${address}.`);
  let numeric;
  if (typeof raw === 'number') {
    numeric = raw;
  } else if (typeof raw === 'string' && /^[+-]?\d+(?:[.,]\d+)?$/u.test(raw.trim())) {
    numeric = Number(raw.trim().replace(',', '.'));
  } else {
    numeric = null;
  }
  if (numeric === null || !Number.isFinite(numeric)) {
    throw new Error(`Texto inválido em ${sheet.name}!${address}.`);
  }
  if (numeric < 0)
    throw new Error(`Nota negativa em ${sheet.name}!${address}.`);
  // The observed scalar is authoritative: 0.1 is 100 thousandths, not a marker.
  // Never prefer a legacy NoteValue.value that may already have collapsed it to zero.
  return canonicalMilliV9(numeric);
}

function ncText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase().replaceAll('/', '') === 'NC';
}

function rrText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase().replaceAll('/', '') === 'RR';
}

/** A cell typed as text: NC or RR in a recovery column, or a number typed as text. */
function textCellV9(
  sheet: GradeSheetRecognition,
  address: string,
  rawValue: string,
  isRecovery: boolean,
): GradebookImportCellV9 | GradebookImportRecoveryCellV9 {
  if (isRecovery && ncText(rawValue)) return ['n'];
  if (isRecovery && rrText(rawValue)) return ['r'];
  if (/^[+-]?\d+(?:[.,]\d+)?$/u.test(rawValue.trim())) {
    const numeric = Number(rawValue.trim().replace(',', '.'));
    return numeric === 0 && !isRecovery ? null : canonicalMilliV9(numeric);
  }
  throw new Error(`Texto inválido em ${sheet.name}!${address}.`);
}

function cellFromObservation(
  sheet: GradeSheetRecognition,
  address: string,
  observation: GradebookImportResultCellObservationV4,
  isRecovery: boolean,
): GradebookImportCellV9 | GradebookImportRecoveryCellV9 {
  const rawSnapshot = snapshot(sheet, address);
  if (Array.isArray(rawSnapshot)) return ['u'];
  switch (observation.classification) {
    case 'manual-legacy-zero':
      // A zero typed in a recovery column is the grade the student got; in AM/U it stays blank.
      return isRecovery ? 0 : null;
    case 'missing-field':
    case 'empty':
    case 'formula-zero':
      // AM/U and formulas keep their separate zero/blank convention (BN-DEC-031).
      return null;
    case 'manual-official-zero-marker':
      // Compatibility with a previously recognized in-memory observation, not stored history.
      return canonicalMilliV9(observation.rawValue);
    case 'manual-negative-number':
      throw new Error(`Nota negativa em ${sheet.name}!${address}.`);
    case 'invalid-text':
      return textCellV9(sheet, address, observation.rawValue, isRecovery);
    case 'manual-positive-number': {
      if (typeof observation.rawValue !== 'number')
        throw new Error(`Valor inválido em ${sheet.name}!${address}.`);
      return canonicalMilliV9(observation.rawValue);
    }
    case 'formula-nonzero': {
      return canonicalMilliV9(observation.cachedValue);
    }
    case 'formula-error-or-missing-cache':
      return ['u'];
  }
}

function maximum(definition: SourceAssessmentDefinitionV2 | undefined): number | null {
  if (!definition) return null;
  const configuration = definition.maximumConfiguration;
  if (configuration.state !== 'numeric') return null;
  if (!Number.isFinite(configuration.rawValue) || configuration.rawValue <= 0) return null;
  return canonicalMilliV9(configuration.rawValue);
}

function description(definition: SourceAssessmentDefinitionV2 | undefined): string | undefined {
  if (definition?.kind !== 'qualitative-activity') return undefined;
  return definition.name.state === 'text' && definition.name.rawValue.trim().length > 0
    ? definition.name.rawValue.trim()
    : undefined;
}

type DefinitionSnapshotV1 = {
  readonly instrumentos: readonly GradebookImportInstrumentV9[];
  readonly unavailableMaximumSlots: readonly GradebookImportInstrumentV9[0][];
  readonly unavailableDescriptionSlots: readonly GradebookImportInstrumentV9[0][];
  readonly unavailableValueSlots: readonly GradebookImportInstrumentV9[0][];
};

function observedBlank(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function unavailableSource(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function qualitativeNameState(
  definition: Extract<SourceAssessmentDefinitionV2, { readonly kind: 'qualitative-activity' }> | undefined,
): { readonly present: boolean; readonly unavailable: boolean } {
  if (!definition) return { present: false, unavailable: true };
  const name = definition.name;
  if (name.state === 'text')
    return { present: name.rawValue.trim().length > 0, unavailable: false };
  if (name.state === 'empty') return { present: false, unavailable: false };
  if (name.state === 'missing-field') return { present: false, unavailable: true };
  if (
    name.state === 'unrecognized' &&
    typeof name.rawValue === 'number' &&
    name.rawValue === definition.order
  )
    return { present: false, unavailable: false };
  return { present: false, unavailable: true };
}

function qualitativeValueEvidence(
  sheet: GradeSheetRecognition,
  sourceColumn: string,
): { readonly observed: boolean; readonly unavailable: boolean } {
  let observed = false;
  let unavailable = false;
  for (const student of sheet.students) {
    if (student.row < 5 || student.row > 50) continue;
    const raw = snapshot(sheet, `${sourceColumn}${student.row}`);
    if (unavailableSource(raw)) unavailable = true;
    else if (!observedBlank(raw)) observed = true;
  }
  return { observed, unavailable };
}

function markUnavailableV9<T>(unavailable: boolean, slots: T[], slot: T) {
  if (unavailable) slots.push(slot);
}

/** An erased qualitative column: empty maximum, and no name or value, read or unreadable. */
function columnErasedV9(
  maximumState: string,
  nameState: { present: boolean; unavailable: boolean },
  values: { observed: boolean; unavailable: boolean },
) {
  return (
    maximumState === 'ambiguous-empty' &&
    !nameState.present &&
    !nameState.unavailable &&
    !values.observed &&
    !values.unavailable
  );
}

function definitionSnapshotV1(sheet: GradeSheetRecognition): DefinitionSnapshotV1 {
  const bySource = new Map(
    sheet.assessmentDefinitions.map((definition) => [definition.sourceSlot, definition]),
  );
  const av1 = maximum(bySource.get('R'));
  const av2 = maximum(bySource.get('S'));
  if (av1 === null || av2 === null) {
    throw new Error(`Máximo de AV1/AV2 ausente ou inválido em ${sheet.name}.`);
  }

  const instrumentos: GradebookImportInstrumentV9[] = [[1, av1], [2, av2], [3, null]];
  const unavailableMaximumSlots: GradebookImportInstrumentV9[0][] = [];
  const unavailableDescriptionSlots: GradebookImportInstrumentV9[0][] = [];
  const unavailableValueSlots: GradebookImportInstrumentV9[0][] = [];

  for (const [index, source] of SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.entries()) {
    const slot = (11 + index) as GradebookImportInstrumentV9[0];
    const definition = bySource.get(source.sourceSlot);
    const qualitative =
      definition?.kind === 'qualitative-activity' ? definition : undefined;
    const maximumState = qualitative?.maximumConfiguration.state ?? 'missing-field';
    const maximumUnavailable =
      maximumState === 'missing-field' ||
      maximumState === 'ambiguous-marker' ||
      maximumState === 'unrecognized';
    const nameState = qualitativeNameState(qualitative);
    const values = qualitativeValueEvidence(sheet, source.studentValueColumn);

    markUnavailableV9(maximumUnavailable, unavailableMaximumSlots, slot);
    markUnavailableV9(nameState.unavailable, unavailableDescriptionSlots, slot);
    markUnavailableV9(values.unavailable, unavailableValueSlots, slot);

    const deleted = columnErasedV9(maximumState, nameState, values);

    // A truly erased qualitative column never enters the canonical payload.
    if (deleted) continue;

    const maximumValue = maximum(qualitative);
    const label = description(qualitative);
    const activeEvidence =
      maximumState === 'numeric' || nameState.present || values.observed;

    // Technical/unreadable absence is not deletion: omit the slot and mark
    // the unread definition so the server preserves its last known metadata.
    if (!activeEvidence && (maximumUnavailable || nameState.unavailable || values.unavailable))
      continue;

    instrumentos.push(
      label === undefined
        ? ([slot, maximumValue] as const)
        : ([slot, maximumValue, label] as const),
    );
  }

  return {
    instrumentos,
    unavailableMaximumSlots,
    unavailableDescriptionSlots,
    unavailableValueSlots,
  };
}

function addressForSlot(slot: GradebookImportInstrumentV9[0], row: number): string {
  if (slot === 1) return `R${row}`;
  if (slot === 2) return `S${row}`;
  if (slot === 3) return `Z${row}`;
  return `${SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2[slot - 11]!.sourceSlot}${row}`;
}

function studentNumber(student: StudentRecognition, sheet: GradeSheetRecognition): number {
  const number = Number(student.number.trim());
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Número de aluno inválido em ${sheet.name}!J${student.row}.`);
  }
  return number;
}

/** The template's student rows (5 to 50). A student below row 50 would be lost, so the file stops. */
function templateStudentsV9(sheet: GradeSheetRecognition): StudentRecognition[] {
  const outside = sheet.students.find((student) => student.row > 50);
  if (outside)
    throw new Error(
      `Aluno na linha ${outside.row} de ${sheet.name}: o modelo aceita alunos só até a linha 50 (46 alunos). Confira a planilha.`,
    );
  return sheet.students.filter((student) => student.row >= 5);
}

function term(
  sheet: GradeSheetRecognition,
  trimester: 1 | 2 | 3,
  runtime: CanonicalImportRuntimeV9,
  heldStudents: Set<number> = new Set(),
  holds: AuditHoldsV1 = EMPTY_HOLDS_V1,
): GradebookImportTermV9 {
  const definitionSnapshot = definitionSnapshotV1(sheet);
  const definitions = definitionSnapshot.instrumentos;
  // BN-DEC-046: columns, rows and results the audit rules hold travel as unavailable.
  const heldColumns = holds.columns.get(sheet.name) ?? new Set<number>();
  const heldResults = holds.results.get(sheet.name) ?? new Set<number>();
  const heldQualitative = holds.qualitativeRows.get(sheet.name) ?? new Set<number>();
  const withHeld = (slots: readonly GradebookImportInstrumentV9[0][]) =>
    [...new Set([...slots, ...([...heldColumns] as GradebookImportInstrumentV9[0][])])];
  const unavailableMaximumSlots = withHeld(definitionSnapshot.unavailableMaximumSlots);
  const unavailableDescriptionSlots = withHeld(definitionSnapshot.unavailableDescriptionSlots);
  const unavailableValueSlots = withHeld(definitionSnapshot.unavailableValueSlots);
  const seen = new Set<number>();
  const alunos = templateStudentsV9(sheet)
    .map((student) => {
      const numero = studentNumber(student, sheet);
      if (seen.has(numero))
        throw new Error(`Número de aluno duplicado em ${sheet.name}: ${numero}.`);
      seen.add(numero);
      let gradeHeld = false;
      const valores = definitions.map(([slot, max]) => {
        const address = addressForSlot(slot, student.row);
        if (heldColumns.has(slot) || (slot >= 11 && heldQualitative.has(student.row))) return HELD_CELL_V9;
        const read = holdableCellV9(runtime, sheet, address, () => cellFromSnapshot(sheet, address));
        gradeHeld ||= read.held;
        const value = read.value;
        if (typeof value === 'number' && max !== null && value > max) {
          // A grade above its maximum is held with the student's result (BN-DEC-046).
          runtime.onWarning?.({
            code: 'above-maximum',
            sheetName: sheet.name,
            cellAddress: address,
            value,
            maximum: max,
          });
          runtime.onHeld?.({ kind: 'cell', sheetName: sheet.name, cellAddress: address, reason: 'invalid-cell' });
          gradeHeld = true;
          return HELD_CELL_V9;
        }
        return value;
      });
      if (heldResults.has(student.row)) gradeHeld = true;
      const observations = student.termResultObservations;
      if (!observations)
        throw new Error(`Resultado trimestral ausente em ${sheet.name}, aluno ${numero}.`);
      const amAddress = `AM${student.row}`;
      // A term result computed from a held grade could be wrong: it is held with it.
      let am: GradebookImportCellV9;
      if (gradeHeld) {
        am = heldResultV9(runtime, sheet, amAddress);
      } else {
        const read = holdableCellV9(runtime, sheet, amAddress, () =>
          cellFromObservation(sheet, amAddress, observations.officialTermGrade, false),
        );
        am = read.value as GradebookImportCellV9;
        gradeHeld = read.held;
      }
      if (gradeHeld) heldStudents.add(numero);
      return [numero, valores, am] as const;
    });
  return {
    trimestre: trimester,
    definitionSnapshotVersion: 1,
    ...(unavailableMaximumSlots.length === 0 ? {} : { unavailableMaximumSlots }),
    ...(unavailableDescriptionSlots.length === 0 ? {} : { unavailableDescriptionSlots }),
    ...(unavailableValueSlots.length === 0 ? {} : { unavailableValueSlots }),
    instrumentos: definitions,
    alunos,
  };
}

function sameNumbers(terms: readonly GradebookImportTermV9[]): boolean {
  const signature = (value: GradebookImportTermV9) =>
    value.alunos.map((row) => row[0]).sort((a, b) => a - b).join(',');
  return terms.every((value) => signature(value) === signature(terms[0]!));
}

function groupKey(sheet: GradeSheetRecognition): string {
  return JSON.stringify([
    normalize(sheet.className),
    normalize(sheet.discipline),
    sheet.disciplineIndex.trim().toUpperCase(),
  ]);
}

function courseGroups(summary: WorkbookSummary): readonly GradeSheetRecognition[][] {
  const groups = new Map<string, GradeSheetRecognition[]>();
  for (const sheet of summary.gradeSheets) {
    if (sheet.stage === 'overview') continue;
    const key = groupKey(sheet);
    groups.set(key, [...(groups.get(key) ?? []), sheet]);
  }
  return [...groups.values()];
}

function offer(
  sheets: readonly GradeSheetRecognition[],
  runtime: CanonicalImportRuntimeV9,
  holds: AuditHoldsV1,
): GradebookImportOfferV9 {
  const heldOffer = sheets.map((sheet) => holds.offers.get(sheet.name)).find((reason) => reason !== undefined);
  if (heldOffer) throw new Error(heldOffer);
  const termSheets = new Map(
    sheets
      .filter((sheet) => sheet.stage.startsWith('trimester-'))
      .map((sheet) => [Number(sheet.stage.at(-1)), sheet]),
  );
  if (termSheets.size !== 3) throw new Error('Conjunto de disciplina sem os três trimestres.');
  const heldStudents = new Set<number>();
  const first = termSheets.get(1);
  if (!first) throw new Error('1º trimestre ausente.');
  const trimestres = [
    term(termSheets.get(1)!, 1, runtime, heldStudents, holds),
    term(termSheets.get(2)!, 2, runtime, heldStudents, holds),
    term(termSheets.get(3)!, 3, runtime, heldStudents, holds),
  ] as const;
  if (!sameNumbers(trimestres)) {
    throw new Error(
      `Os números dos alunos divergem entre trimestres em ${first.className} / ${first.discipline}.`,
    );
  }

  const recovery = sheets.find((sheet) => sheet.stage === 'recovery') ?? null;
  const recuperacao = recovery
    ? templateStudentsV9(recovery)
        .filter((student) => student.recovery !== null)
        .map((student) => {
          const numero = studentNumber(student, recovery);
          const observations = student.recovery!.resultObservations;
          const heldRecovery = holds.recoveryCells.get(recovery.name);
          const recoveryCell = (column: 'R' | 'S' | 'T', observation: typeof observations.trimester1) =>
            heldRecovery?.has(`${column}${student.row}`)
              ? { value: HELD_CELL_V9, held: true }
              : holdableCellV9(runtime, recovery, `${column}${student.row}`, () =>
                  cellFromObservation(recovery, `${column}${student.row}`, observation, true),
                );
          const rec = [
            recoveryCell('R', observations.trimester1),
            recoveryCell('S', observations.trimester2),
            recoveryCell('T', observations.trimester3),
          ];
          const uAddress = `U${student.row}`;
          // U is computed from the AMs and the recoveries: a held one holds U too.
          const u = rec.some((cell) => cell.held) || heldStudents.has(numero)
            ? heldResultV9(runtime, recovery, uAddress)
            : (holdableCellV9(runtime, recovery, uAddress, () =>
                cellFromObservation(recovery, uAddress, observations.totalAfterRecovery, false),
              ).value as GradebookImportCellV9);
          return [
            numero,
            rec[0]!.value as GradebookImportRecoveryCellV9,
            rec[1]!.value as GradebookImportRecoveryCellV9,
            rec[2]!.value as GradebookImportRecoveryCellV9,
            u,
          ] as const;
        })
    : null;
  return {
    turmaCodigo: first.className.trim().toUpperCase(),
    disciplina: first.discipline.trim(),
    trimestres,
    recuperacao,
  };
}

/** The Relação: the roster of every class of the year, as read. */
function relationRequestV9(
  result: BatchSuccess,
  relation: NonNullable<SummaryWithRelationV9['masterRelationV9']>,
  runtime: CanonicalImportRuntimeV9,
): GradebookImportPersistenceRequestV9 {
  if (!isGradebookAcademicYearV2(relation.ano)) throw new Error('Ano letivo inválido na Relação.');
  const total = relation.turmas.length;
  runtime.onProgress?.({ stage: 'roster', current: 0, total });
  const request = {
    transportVersion: 9,
    operation: 'persist-relacao',
    manifest: manifest(result),
    ano: relation.ano,
    turmas: relation.turmas,
  } as const;
  runtime.onProgress?.({ stage: 'roster', current: total, total });
  runtime.onProgress?.({ stage: 'compacting', current: 1, total: 1 });
  if (!isGradebookImportPersistenceRequestV9(request))
    throw new Error('Relação canônica não passou na validação local.');
  return request;
}

/** Every class/subject the import can read as a whole; one it cannot is held (left out, it stays as it is). */
function readableOffersV9(
  summary: SummaryWithRelationV9,
  groups: ReturnType<typeof courseGroups>,
  runtime: CanonicalImportRuntimeV9,
): GradebookImportOfferV9[] {
  const ofertas: GradebookImportOfferV9[] = [];
  const heldReasons: string[] = [];
  const { holds } = auditWorkbookV1(summary);
  for (const [index, sheets] of groups.entries()) {
    try {
      ofertas.push(offer(sheets, runtime, holds));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'Turma/disciplina ilegível.';
      heldReasons.push(reason);
      runtime.onHeld?.({ kind: 'offer', sheetNames: sheets.map((sheet) => sheet.name), reason });
    }
    runtime.onProgress?.({ stage: 'grades', current: index + 1, total: groups.length });
  }
  if (ofertas.length === 0)
    throw new Error(`Nenhuma turma desta planilha pôde ser lançada. ${heldReasons[0] ?? ''}`.trim());
  return ofertas;
}

/** One class and subject appears once per file. */
function assertNoDuplicateOfferV9(ofertas: readonly GradebookImportOfferV9[]): void {
  const logical = new Set<string>();
  for (const item of ofertas) {
    const key = JSON.stringify([
      item.turmaCodigo.trim().toUpperCase(),
      item.disciplina.trim().toLocaleLowerCase('pt-BR'),
    ]);
    if (logical.has(key)) {
      throw new Error(
        `Oferta lógica duplicada no arquivo: ${item.turmaCodigo} / ${item.disciplina}.`,
      );
    }
    logical.add(key);
  }
}

export function createGradebookCanonicalImportRequestV9(
  result: BatchSuccess,
  runtime: CanonicalImportRuntimeV9 = {},
): GradebookImportPersistenceRequestV9 {
  const summary = result.summary as SummaryWithRelationV9;
  if (summary.masterRelationV9) return relationRequestV9(result, summary.masterRelationV9, runtime);

  if (!isGradebookAcademicYearV2(summary.academicYear))
    throw new Error('Ano letivo ausente ou inválido em CONFIGURAÇÃO!C2.');
  const professor = summary.teacherName?.trim();
  if (!professor) throw new Error('Professor não reconhecido em CONFIGURAÇÃO!A2.');
  const groups = courseGroups(summary);
  if (groups.length === 0) throw new Error('Nenhuma oferta acadêmica reconhecida.');
  runtime.onProgress?.({ stage: 'grades', current: 0, total: groups.length });
  const ofertas = readableOffersV9(summary, groups, runtime);
  assertNoDuplicateOfferV9(ofertas);
  runtime.onProgress?.({ stage: 'recovery', current: groups.length, total: groups.length });
  runtime.onProgress?.({ stage: 'compacting', current: 1, total: 1 });
  const request = {
    transportVersion: 9,
    operation: 'persist-notas',
    granularObservationVersion: 1,
    manifest: manifest(result),
    ano: summary.academicYear as number,
    professor,
    ofertas,
  } as const;
  if (!isGradebookImportPersistenceRequestV9(request))
    throw new Error('Pacote acadêmico canônico não passou na validação local.');
  return request;
}

const unavailableCellV9 = (value: unknown) => Array.isArray(value) && value[0] === 'u';
const countUnavailableV9 = (values: readonly unknown[]) => values.filter(unavailableCellV9).length;

/** Cells the file could not read (marked 'u'): term values and AM, then REC and U. */
export function unavailableCellsV9(request: GradebookImportPersistenceRequestV9): number {
  if (request.operation === 'persist-relacao') return 0;
  let total = 0;
  for (const oferta of request.ofertas) {
    for (const term of oferta.trimestres)
      for (const [, values, am] of term.alunos) total += countUnavailableV9([...values, am]);
    for (const [, rec1, rec2, rec3, u] of oferta.recuperacao ?? [])
      total += countUnavailableV9([rec1, rec2, rec3, u]);
  }
  return total;
}
