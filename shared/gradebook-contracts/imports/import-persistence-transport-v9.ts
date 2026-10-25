import type { GradebookImportPersistenceSummaryV2 } from './import-persistence-transport-v2';
import { isGradebookAcademicYearV2 } from '../academic-year-v2';

export const GRADEBOOK_IMPORT_PERSISTENCE_TRANSPORT_VERSION_V9 = 9 as const;
export const GRADEBOOK_IMPORT_PERSISTENCE_BODY_BYTES_V9 = 2_000_000;

export interface GradebookImportManifestV9 {
  readonly fileName: string;
  readonly sha256: string;
  readonly parserVersion: string;
}

/** number = canonical INTEGER x1000; null = explicit empty/clear; ['u'] = unreadable/unavailable, preserve prior value. */
export type GradebookImportCellV9 = number | null | readonly ['u'];
/** Recovery additionally accepts ['n'] for N/C and ['r'] for terminal R/R. */
export type GradebookImportRecoveryCellV9 = GradebookImportCellV9 | readonly ['n'] | readonly ['r'];

export type GradebookRelationStudentV9 = readonly [
  numero: number,
  nome: string,
  situacao: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
  turmaRelacionadaCodigo?: string,
];

export interface GradebookRelationClassV9 {
  readonly codigo: string;
  readonly nome: string;
  readonly etapa: number;
  readonly turno: string;
  readonly alunos: readonly GradebookRelationStudentV9[];
}

export interface GradebookRelationImportRequestV9 {
  readonly transportVersion: 9;
  readonly operation: 'persist-relacao';
  readonly manifest: GradebookImportManifestV9;
  readonly ano: number;
  readonly turmas: readonly GradebookRelationClassV9[];
  readonly movementReview?: GradebookRelationMovementConfirmationV9;
}

export interface GradebookRelationMovementPositionV9 {
  readonly classCode: string;
  readonly number: number;
}

export interface GradebookRelationMovementEndpointV9 extends GradebookRelationMovementPositionV9 {
  readonly name: string;
}

export interface GradebookRelationMovementPairV9 {
  readonly origin: GradebookRelationMovementPositionV9;
  readonly destination: GradebookRelationMovementPositionV9;
}

export interface GradebookRelationMovementGroupV9 {
  readonly origins: readonly GradebookRelationMovementEndpointV9[];
  readonly destinations: readonly GradebookRelationMovementEndpointV9[];
}

export interface GradebookRelationMovementReviewV9 {
  readonly digest: string;
  readonly groups: readonly GradebookRelationMovementGroupV9[];
}

export interface GradebookRelationMovementConfirmationV9 {
  readonly digest: string;
  readonly pairs: readonly GradebookRelationMovementPairV9[];
}

export type GradebookImportInstrumentV9 = readonly [
  slot: 1 | 2 | 3 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20,
  maximo: number | null,
  descricao?: string,
];

export type GradebookImportTermStudentV9 = readonly [
  numero: number,
  valores: readonly GradebookImportCellV9[],
  amFonte: GradebookImportCellV9,
];

export interface GradebookImportTermV9 {
  readonly trimestre: 1 | 2 | 3;
  /** V1 means this term is a complete current snapshot of qualitative definitions. */
  readonly definitionSnapshotVersion?: 1;
  /** Definition maximum could not be read safely; preserve the previous maximum for this slot. */
  readonly unavailableMaximumSlots?: readonly GradebookImportInstrumentV9[0][];
  /** Definition label could not be read safely; preserve the previous label for this slot. */
  readonly unavailableDescriptionSlots?: readonly GradebookImportInstrumentV9[0][];
  /** At least one student cell in an otherwise absent slot could not be read; do not delete the slot. */
  readonly unavailableValueSlots?: readonly GradebookImportInstrumentV9[0][];
  readonly instrumentos: readonly GradebookImportInstrumentV9[];
  readonly alunos: readonly GradebookImportTermStudentV9[];
}

export type GradebookImportRecoveryStudentV9 = readonly [
  numero: number,
  rec1: GradebookImportRecoveryCellV9,
  rec2: GradebookImportRecoveryCellV9,
  rec3: GradebookImportRecoveryCellV9,
  uFonte: GradebookImportCellV9,
];

export interface GradebookImportOfferV9 {
  readonly turmaCodigo: string;
  readonly disciplina: string;
  readonly trimestres: readonly [
    GradebookImportTermV9,
    GradebookImportTermV9,
    GradebookImportTermV9,
  ];
  readonly recuperacao: readonly GradebookImportRecoveryStudentV9[] | null;
}

export interface GradebookNotesImportRequestV9 {
  readonly transportVersion: 9;
  readonly operation: 'persist-notas';
  /** V1 distinguishes an observed empty cell from a cell never read. */
  readonly granularObservationVersion?: 1;
  readonly manifest: GradebookImportManifestV9;
  readonly ano: number;
  readonly professor: string;
  readonly ofertas: readonly GradebookImportOfferV9[];
}

export type GradebookImportPersistenceRequestV9 =
  GradebookRelationImportRequestV9 | GradebookNotesImportRequestV9;

export interface GradebookRelationWarningV9 {
  readonly code: 'movement-spelling';
  readonly classCode: string;
  readonly number: number;
  readonly relatedClassCode: string;
}

export type GradebookImportPersistenceResponseV9 =
  | {
      readonly transportVersion: 9;
      readonly state: 'applied' | 'no-changes';
      readonly summary: GradebookImportPersistenceSummaryV2;
      readonly warnings?: readonly GradebookRelationWarningV9[];
    }
  | {
      readonly transportVersion: 9;
      readonly state: 'blocked' | 'conflict' | 'review-required';
      readonly reason: string;
      readonly movementReview?: GradebookRelationMovementReviewV9;
    }
  | {
      readonly transportVersion: 9;
      readonly state: 'invalid-request';
      readonly reason: string;
    }
  | { readonly transportVersion: 9; readonly state: 'not-authorized' | 'unavailable' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes('\u0000')
  );
}

function validManifest(value: unknown): value is GradebookImportManifestV9 {
  return (
    record(value) &&
    nonEmptyText(value.fileName, 512) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    nonEmptyText(value.parserVersion, 128)
  );
}

function validCanonicalInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validCell(value: unknown): value is GradebookImportCellV9 {
  return (
    value === null ||
    validCanonicalInteger(value) ||
    (Array.isArray(value) && value.length === 1 && value[0] === 'u')
  );
}

function validRecoveryCell(value: unknown): value is GradebookImportRecoveryCellV9 {
  return (
    validCell(value) ||
    (Array.isArray(value) && value.length === 1 && (value[0] === 'n' || value[0] === 'r'))
  );
}

/** One student row: a new number, a name, a status 0–7, and the related class only for 6 and 7. */
function validRelationStudentV9(aluno: unknown, numbers: Set<number>): boolean {
  if (!Array.isArray(aluno) || (aluno.length !== 3 && aluno.length !== 4)) return false;
  if (!Number.isSafeInteger(aluno[0]) || aluno[0] <= 0 || numbers.has(aluno[0])) return false;
  numbers.add(aluno[0]);
  if (
    !nonEmptyText(aluno[1], 256) ||
    !Number.isSafeInteger(aluno[2]) ||
    aluno[2] < 0 ||
    aluno[2] > 7
  )
    return false;
  const related = aluno[3];
  if (aluno[2] === 6 || aluno[2] === 7) return nonEmptyText(related, 32);
  return related === undefined;
}

/** One class: code, name, stage and shift, a code not seen before, and up to 64 valid students. */
function validRelationClassV9(turma: unknown, classCodes: Set<string>): boolean {
  if (!record(turma) || !nonEmptyText(turma.codigo, 32) || !nonEmptyText(turma.nome, 128))
    return false;
  if (
    !Number.isSafeInteger(turma.etapa) ||
    Number(turma.etapa) <= 0 ||
    !nonEmptyText(turma.turno, 64)
  )
    return false;
  const classKey = turma.codigo.trim().toUpperCase();
  if (classCodes.has(classKey)) return false;
  classCodes.add(classKey);
  if (!Array.isArray(turma.alunos) || turma.alunos.length > 64) return false;
  const numbers = new Set<number>();
  return turma.alunos.every((aluno) => validRelationStudentV9(aluno, numbers));
}

function validRelation(value: Record<string, unknown>): boolean {
  if (value.movementReview !== undefined && !validMovementConfirmation(value.movementReview))
    return false;
  if (!isGradebookAcademicYearV2(value.ano)) return false;
  if (!Array.isArray(value.turmas) || value.turmas.length === 0 || value.turmas.length > 64)
    return false;
  const classCodes = new Set<string>();
  for (const turma of value.turmas) if (!validRelationClassV9(turma, classCodes)) return false;
  for (const turma of value.turmas as GradebookRelationClassV9[]) {
    for (const aluno of turma.alunos) {
      if ((aluno[2] === 6 || aluno[2] === 7) && !classCodes.has(aluno[3]!.trim().toUpperCase()))
        return false;
    }
  }
  return true;
}

function validMovementPosition(value: unknown, named = false): boolean {
  return record(value) && Object.keys(value).length === (named ? 3 : 2) &&
    nonEmptyText(value.classCode, 32) && Number.isSafeInteger(value.number) && Number(value.number) > 0 &&
    (!named || nonEmptyText(value.name, 256));
}

function validMovementDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validMovementConfirmation(value: unknown): boolean {
  return record(value) && Object.keys(value).length === 2 && validMovementDigest(value.digest) &&
    Array.isArray(value.pairs) && value.pairs.length > 0 && value.pairs.length <= 2048 &&
    value.pairs.every((pair) => record(pair) && Object.keys(pair).length === 2 &&
      validMovementPosition(pair.origin) && validMovementPosition(pair.destination));
}

function validMovementReview(value: unknown): boolean {
  return record(value) && Object.keys(value).length === 2 && validMovementDigest(value.digest) &&
    Array.isArray(value.groups) && value.groups.length > 0 && value.groups.length <= 2048 &&
    value.groups.every((group) => record(group) && Object.keys(group).length === 2 &&
      Array.isArray(group.origins) && group.origins.length > 0 && group.origins.length <= 64 &&
      Array.isArray(group.destinations) && group.destinations.length > 0 && group.destinations.length <= 64 &&
      group.origins.every((position) => validMovementPosition(position, true)) &&
      group.destinations.every((position) => validMovementPosition(position, true)));
}

const SLOTS = new Set([1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

function validUnavailableSlots(input: unknown): boolean {
  if (input === undefined) return true;
  if (!Array.isArray(input) || input.length > 10) return false;
  const seen = new Set<number>();
  for (const slot of input) {
    if (!Number.isSafeInteger(slot) || slot < 11 || slot > 20 || seen.has(slot)) return false;
    seen.add(slot);
  }
  return true;
}

function validInstrument(value: unknown, slots: Set<number>): boolean {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return false;
  const slot = value[0];
  if (!Number.isSafeInteger(slot) || !SLOTS.has(slot) || slots.has(slot)) return false;
  if (value[1] !== null && (!validCanonicalInteger(value[1]) || value[1] <= 0)) return false;
  if (value[2] !== undefined && !nonEmptyText(value[2], 512)) return false;
  slots.add(slot);
  return true;
}

function validTermStudent(
  value: unknown,
  instrumentCount: number,
  numbers: Set<number>,
): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isSafeInteger(value[0]) ||
    value[0] <= 0 ||
    numbers.has(value[0])
  )
    return false;
  if (
    !Array.isArray(value[1]) ||
    value[1].length !== instrumentCount ||
    !value[1].every(validCell) ||
    !validCell(value[2])
  )
    return false;
  numbers.add(value[0]);
  return true;
}

function validTerm(value: unknown, termIndex: number): boolean {
  if (
    !record(value) ||
    value.trimestre !== termIndex + 1 ||
    !Array.isArray(value.instrumentos) ||
    !Array.isArray(value.alunos)
  )
    return false;
  if (value.instrumentos.length === 0 || value.instrumentos.length > 13 || value.alunos.length > 64)
    return false;

  const snapshotVersion = value.definitionSnapshotVersion;
  if (snapshotVersion !== undefined && snapshotVersion !== 1) return false;
  if (
    snapshotVersion === undefined &&
    (value.unavailableMaximumSlots !== undefined ||
      value.unavailableDescriptionSlots !== undefined ||
      value.unavailableValueSlots !== undefined)
  )
    return false;
  if (
    !validUnavailableSlots(value.unavailableMaximumSlots) ||
    !validUnavailableSlots(value.unavailableDescriptionSlots) ||
    !validUnavailableSlots(value.unavailableValueSlots)
  )
    return false;

  const slots = new Set<number>();
  for (const instrumento of value.instrumentos) {
    if (!validInstrument(instrumento, slots)) return false;
  }
  if (snapshotVersion === 1 && (!slots.has(1) || !slots.has(2) || !slots.has(3))) return false;

  const numbers = new Set<number>();
  for (const aluno of value.alunos) {
    if (!validTermStudent(aluno, value.instrumentos.length, numbers)) return false;
  }
  return true;
}

function validRecovery(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length > 64) return false;
  const numbers = new Set<number>();
  for (const aluno of value) {
    if (
      !Array.isArray(aluno) ||
      aluno.length !== 5 ||
      !Number.isSafeInteger(aluno[0]) ||
      aluno[0] <= 0 ||
      numbers.has(aluno[0])
    )
      return false;
    if (
      !validRecoveryCell(aluno[1]) ||
      !validRecoveryCell(aluno[2]) ||
      !validRecoveryCell(aluno[3]) ||
      !validCell(aluno[4])
    )
      return false;
    numbers.add(aluno[0]);
  }
  return true;
}

function validOffer(value: unknown, offers: Set<string>): boolean {
  if (!record(value) || !nonEmptyText(value.turmaCodigo, 32) || !nonEmptyText(value.disciplina, 256))
    return false;
  const offerKey = JSON.stringify([
    value.turmaCodigo.trim().toUpperCase(),
    value.disciplina.trim().toLocaleLowerCase('pt-BR'),
  ]);
  if (offers.has(offerKey)) return false;
  if (!Array.isArray(value.trimestres) || value.trimestres.length !== 3) return false;
  for (const [termIndex, term] of value.trimestres.entries()) {
    if (!validTerm(term, termIndex)) return false;
  }
  if (!validRecovery(value.recuperacao)) return false;
  offers.add(offerKey);
  return true;
}

function validNotes(value: Record<string, unknown>): boolean {
  if (value.granularObservationVersion !== undefined && value.granularObservationVersion !== 1)
    return false;
  if (!isGradebookAcademicYearV2(value.ano)) return false;
  if (
    !nonEmptyText(value.professor, 256) ||
    !Array.isArray(value.ofertas) ||
    value.ofertas.length === 0 ||
    value.ofertas.length > 128
  )
    return false;

  const offers = new Set<string>();
  return value.ofertas.every((offer) => validOffer(offer, offers));
}

export function inspectGradebookImportPersistenceRequestV9(
  value: unknown,
): 'ready' | 'invalid-request' | 'payload-too-large' {
  try {
    if (!record(value) || value.transportVersion !== 9 || !validManifest(value.manifest))
      return 'invalid-request';
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      GRADEBOOK_IMPORT_PERSISTENCE_BODY_BYTES_V9
    )
      return 'payload-too-large';
    if (value.operation === 'persist-relacao')
      return validRelation(value) ? 'ready' : 'invalid-request';
    if (value.operation === 'persist-notas') return validNotes(value) ? 'ready' : 'invalid-request';
    return 'invalid-request';
  } catch {
    return 'invalid-request';
  }
}

export function isGradebookImportPersistenceRequestV9(
  value: unknown,
): value is GradebookImportPersistenceRequestV9 {
  return inspectGradebookImportPersistenceRequestV9(value) === 'ready';
}

export function isGradebookImportPersistenceResponseV9(
  value: unknown,
): value is GradebookImportPersistenceResponseV9 {
  if (!record(value) || value.transportVersion !== 9 || typeof value.state !== 'string')
    return false;
  if (value.state === 'applied' || value.state === 'no-changes') {
    return record(value.summary) && (value.warnings === undefined ||
      (Array.isArray(value.warnings) && value.warnings.length <= 4096 && value.warnings.every((warning) =>
        record(warning) && Object.keys(warning).length === 4 && warning.code === 'movement-spelling' &&
        nonEmptyText(warning.classCode, 32) && nonEmptyText(warning.relatedClassCode, 32) &&
        Number.isSafeInteger(warning.number) && Number(warning.number) > 0)));
  }
  if (
    value.state === 'blocked' ||
    value.state === 'conflict' ||
    value.state === 'review-required' ||
    value.state === 'invalid-request'
  )
    return nonEmptyText(value.reason, 512) && (value.movementReview === undefined ||
      (value.state === 'review-required' && validMovementReview(value.movementReview)));
  return value.state === 'not-authorized' || value.state === 'unavailable';
}
