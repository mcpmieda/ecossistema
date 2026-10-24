import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentV1,
  StudentId,
  StudentStatusEventV1,
  StudentV1,
  TeachingAssignmentId,
} from '../../../../../shared/gradebook-contracts/entities';
import {
  CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
  PERFORMANCE_AUTHORITY_MODE_V1,
  PERFORMANCE_COLUMN_ORDER_V1,
  PERFORMANCE_LENSES_V1,
  PERFORMANCE_MODES_V1,
  PERFORMANCE_ROW_ORDER_V1,
  comparePerformanceComponentColumnsV1,
  comparePerformanceStudentRowsV1,
  inspectClassPerformanceRequestV1,
  isClassPerformanceReadModelValidV1,
  isPerformancePeriodV1,
  type ClassPerformanceReadModelV1,
  type ClassPerformanceRequestV1,
  type PerformanceAssessmentValueV1,
  type PerformanceAssessmentsProjectionV1,
  type PerformanceCellDetailRefV1,
  type PerformanceCellV1,
  type PerformanceColumnCursorV1,
  type PerformanceComparedApplicabilityV1,
  type PerformanceComparedGradeValueV1,
  type PerformanceComponentColumnV1,
  type PerformanceLensV1,
  type PerformancePeriodV1,
  type PerformanceQualitativeProjectionV1,
  type PerformanceQuantitativeProjectionV1,
  type PerformanceResultProjectionV1,
  type PerformanceRowCursorV1,
  type PerformanceSignalV1,
  type PerformanceStudentDetailRefV1,
  type PerformanceStudentSituationV1,
  type PerformanceValueComparisonV1,
} from '../../../../../shared/gradebook-contracts/performance/class-performance-read-model-v1';
import {
  PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1,
  PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1,
  PERFORMANCE_PROPORTIONAL_RELATIONS_V2,
  type PerformanceComparisonConfigurationV1,
  type PerformanceComparisonProfileRefV2,
  type PerformanceComparisonProjectionV2,
  type PerformanceProfileCompatibilityV2,
} from '../../../../../shared/gradebook-contracts/performance/performance-comparison-contract-v2';
import {
  ACADEMIC_RESULT_STATES_V1,
  RESULT_COVERAGE_STATES_V1,
  type AcademicGradeValueV1,
  type ApplicabilityV1,
  type ResultCoverageV1,
} from '../../../../../shared/gradebook-contracts/results/results-contract-v1';
import type { AcademicRecordV1 } from '../../../../../src/gradebook-domain/ports/persistence/persistence-ports-v1';

const ROW_CURSOR_PREFIX = 'class-performance-row-v1.';
const COLUMN_CURSOR_PREFIX = 'class-performance-column-v1.';
const STUDENT_DETAIL_PREFIX = 'class-performance-student-detail-v1.';
const CELL_DETAIL_PREFIX = 'class-performance-cell-detail-v1.';

export type ClassPerformanceReadModelErrorCodeV1 =
  | 'invalid-request'
  | 'invalid-row-cursor'
  | 'invalid-column-cursor'
  | 'invalid-detail-reference'
  | 'incompatible-source-result'
  | 'source-failure';

const ERROR_MESSAGES: Record<ClassPerformanceReadModelErrorCodeV1, string> = {
  'invalid-request': 'A solicitação do read model de Desempenho é inválida.',
  'invalid-row-cursor': 'O cursor de linhas do read model de Desempenho é inválido.',
  'invalid-column-cursor': 'O cursor de colunas do read model de Desempenho é inválido.',
  'invalid-detail-reference': 'A referência de detalhe do read model de Desempenho é inválida.',
  'incompatible-source-result': 'A fonte do read model de Desempenho retornou dados incompatíveis.',
  'source-failure': 'A fonte do read model de Desempenho não pôde ser consultada.',
};

export class ClassPerformanceReadModelErrorV1 extends Error {
  readonly code: ClassPerformanceReadModelErrorCodeV1;

  constructor(code: ClassPerformanceReadModelErrorCodeV1) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ClassPerformanceReadModelErrorV1';
    this.code = code;
  }
}

export interface PerformanceMatrixSourceRequestV1 {
  readonly contractVersion: typeof CLASS_PERFORMANCE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly period: PerformancePeriodV1;
  readonly mode: ClassPerformanceRequestV1['mode'];
  readonly lens: PerformanceLensV1;
  readonly comparisonPeriod: PerformancePeriodV1 | null;
}

export interface PerformanceSourceSignalV1 {
  readonly code: string;
  readonly explanation: string;
  readonly source: PerformanceSignalV1['source'];
  readonly detail: 'cell' | 'none';
}

interface PerformanceMatrixSourceCellBaseV1 {
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly authorityMode: typeof PERFORMANCE_AUTHORITY_MODE_V1;
  readonly coverage: ResultCoverageV1;
  readonly comparison: PerformanceValueComparisonV1 | null;
  readonly signals: readonly PerformanceSourceSignalV1[];
  readonly detailKey: string;
  /** Additive V2 runtime projection; the frozen V1 comparison remains separately interpretable. */
  readonly proportionalComparison?: PerformanceComparisonProjectionV2;
}

export type PerformanceMatrixSourceCellV1 =
  | (PerformanceMatrixSourceCellBaseV1 & {
      readonly lens: 'result';
      readonly projection: PerformanceResultProjectionV1;
    })
  | (PerformanceMatrixSourceCellBaseV1 & {
      readonly lens: 'quantitative';
      readonly projection: PerformanceQuantitativeProjectionV1;
    })
  | (PerformanceMatrixSourceCellBaseV1 & {
      readonly lens: 'qualitative';
      readonly projection: PerformanceQualitativeProjectionV1;
    })
  | (PerformanceMatrixSourceCellBaseV1 & {
      readonly lens: 'assessments';
      readonly projection: PerformanceAssessmentsProjectionV1;
    });

export interface PerformanceMatrixSourceRowV1 {
  readonly sourcePosition: number | null;
  readonly studentId: StudentId;
  readonly displayName: string;
  readonly situation: PerformanceStudentSituationV1;
  readonly detailKey: string;
  readonly cells: readonly PerformanceMatrixSourceCellV1[];
}

/**
 * One provider-independent, already-resolved projection. Implementations may read any physical
 * provider in one batch, but must supply only official entity/result semantics to this boundary.
 */
export interface PerformanceMatrixSourceSnapshotV1 extends PerformanceMatrixSourceRequestV1 {
  readonly authorityMode: typeof PERFORMANCE_AUTHORITY_MODE_V1;
  readonly coverage: ResultCoverageV1;
  readonly columns: readonly PerformanceComponentColumnV1[];
  readonly rows: readonly PerformanceMatrixSourceRowV1[];
}

export interface PerformanceStudentDetailSourceRequestV1 {
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly detailKey: string;
}

export interface PerformanceStudentDetailSourceV1 extends PerformanceStudentDetailSourceRequestV1 {
  readonly student: StudentV1 | null;
  readonly enrollment: EnrollmentV1;
  readonly statusHistory: readonly StudentStatusEventV1[];
}

export interface PerformanceCellDetailSourceRequestV1 extends PerformanceMatrixSourceRequestV1 {
  readonly detailKey: string;
}

export interface PerformanceCellDetailSourceV1 extends PerformanceCellDetailSourceRequestV1 {
  readonly studentId: StudentId;
  readonly cell: PerformanceMatrixSourceCellV1;
  readonly officialRecords: readonly AcademicRecordV1[];
}

export interface ClassPerformanceSourceV1 {
  loadMatrix(
    request: PerformanceMatrixSourceRequestV1,
  ): Promise<PerformanceMatrixSourceSnapshotV1 | null>;
  loadStudentDetail(
    request: PerformanceStudentDetailSourceRequestV1,
  ): Promise<PerformanceStudentDetailSourceV1 | null>;
  loadCellDetail(
    request: PerformanceCellDetailSourceRequestV1,
  ): Promise<PerformanceCellDetailSourceV1 | null>;
}

export interface PerformanceStudentDetailV1 {
  readonly detailRef: PerformanceStudentDetailRefV1;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly student: StudentV1 | null;
  readonly enrollment: EnrollmentV1;
  readonly statusHistory: readonly StudentStatusEventV1[];
}

export interface PerformanceCellDetailV1 extends PerformanceMatrixSourceRequestV1 {
  readonly detailRef: PerformanceCellDetailRefV1;
  readonly studentId: StudentId;
  readonly authorityMode: typeof PERFORMANCE_AUTHORITY_MODE_V1;
  readonly cell: PerformanceCellV1;
  /** Raw evidence may exist inside official records here, never in the matrix projection. */
  readonly officialRecords: readonly AcademicRecordV1[];
}

export interface ClassPerformanceReadModelProviderV1 {
  get(request: ClassPerformanceRequestV1): Promise<ClassPerformanceReadModelV1 | null>;
  getStudentDetail(
    detailRef: PerformanceStudentDetailRefV1,
  ): Promise<PerformanceStudentDetailV1 | null>;
  getCellDetail(detailRef: PerformanceCellDetailRefV1): Promise<PerformanceCellDetailV1 | null>;
}

interface CursorPayloadV1 {
  readonly version: 1;
  readonly axis: 'rows' | 'columns';
  readonly scope: string;
  readonly key: string;
}

interface StudentDetailPayloadV1 {
  readonly version: 1;
  readonly academicYearId: string;
  readonly classGroupId: string;
  readonly detailKey: string;
}

interface CellDetailPayloadV1 {
  readonly version: 1;
  readonly scope: string;
  readonly detailKey: string;
}

function fail(code: ClassPerformanceReadModelErrorCodeV1): never {
  throw new ClassPerformanceReadModelErrorV1(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireNonEmpty(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('incompatible-source-result');
  }
  return value;
}

function samePeriod(left: PerformancePeriodV1, right: PerformancePeriodV1): boolean {
  if (left.kind === 'annual') return right.kind === 'annual';
  return right.kind === 'term' && left.term === right.term;
}

function sameOptionalPeriod(
  left: PerformancePeriodV1 | null,
  right: PerformancePeriodV1 | null,
): boolean {
  return left === null ? right === null : right !== null && samePeriod(left, right);
}

function clonePeriod(period: PerformancePeriodV1): PerformancePeriodV1 {
  return period.kind === 'annual' ? { kind: 'annual' } : { kind: 'term', term: period.term };
}

function cloneOptionalPeriod(period: PerformancePeriodV1 | null): PerformancePeriodV1 | null {
  return period === null ? null : clonePeriod(period);
}

function matrixSourceRequest(request: ClassPerformanceRequestV1): PerformanceMatrixSourceRequestV1 {
  return {
    contractVersion: CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
    academicYearId: request.academicYearId,
    classGroupId: request.classGroupId,
    period: clonePeriod(request.period),
    mode: request.mode,
    lens: request.lens,
    comparisonPeriod: cloneOptionalPeriod(request.comparisonPeriod),
  };
}

function scopeFor(request: PerformanceMatrixSourceRequestV1): string {
  return JSON.stringify({
    version: 1,
    academicYearId: request.academicYearId,
    classGroupId: request.classGroupId,
    period: request.period,
    mode: request.mode,
    lens: request.lens,
    comparisonPeriod: request.comparisonPeriod,
  });
}

function parseScope(value: string): PerformanceMatrixSourceRequestV1 | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, [
        'version',
        'academicYearId',
        'classGroupId',
        'period',
        'mode',
        'lens',
        'comparisonPeriod',
      ]) ||
      parsed.version !== 1 ||
      typeof parsed.academicYearId !== 'string' ||
      parsed.academicYearId.trim().length === 0 ||
      typeof parsed.classGroupId !== 'string' ||
      parsed.classGroupId.trim().length === 0 ||
      !isPerformancePeriodV1(parsed.period) ||
      !PERFORMANCE_MODES_V1.includes(parsed.mode as ClassPerformanceRequestV1['mode']) ||
      !PERFORMANCE_LENSES_V1.includes(parsed.lens as PerformanceLensV1) ||
      (parsed.comparisonPeriod !== null && !isPerformancePeriodV1(parsed.comparisonPeriod))
    ) {
      return null;
    }
    return {
      contractVersion: CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
      academicYearId: parsed.academicYearId as AcademicYearId,
      classGroupId: parsed.classGroupId as ClassGroupId,
      period: clonePeriod(parsed.period),
      mode: parsed.mode as ClassPerformanceRequestV1['mode'],
      lens: parsed.lens as PerformanceLensV1,
      comparisonPeriod: cloneOptionalPeriod(parsed.comparisonPeriod as PerformancePeriodV1 | null),
    };
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0)!);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeToken(prefix: string, payload: object): string {
  return `${prefix}${encodeBase64Url(JSON.stringify(payload))}`;
}

function decodeToken(prefix: string, token: string): unknown | null {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return null;
  const decoded = decodeBase64Url(token.slice(prefix.length));
  if (decoded === null) return null;
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
}

function encodeCursor(
  axis: CursorPayloadV1['axis'],
  scope: string,
  key: string,
): PerformanceRowCursorV1 | PerformanceColumnCursorV1 {
  const prefix = axis === 'rows' ? ROW_CURSOR_PREFIX : COLUMN_CURSOR_PREFIX;
  return encodeToken(prefix, { version: 1, axis, scope, key }) as
    PerformanceRowCursorV1 | PerformanceColumnCursorV1;
}

function decodeCursor(
  axis: CursorPayloadV1['axis'],
  scope: string,
  cursor: string,
): CursorPayloadV1 | null {
  const prefix = axis === 'rows' ? ROW_CURSOR_PREFIX : COLUMN_CURSOR_PREFIX;
  const value = decodeToken(prefix, cursor);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'axis', 'scope', 'key']) ||
    value.version !== 1 ||
    value.axis !== axis ||
    value.scope !== scope ||
    typeof value.key !== 'string' ||
    value.key.trim().length === 0
  ) {
    return null;
  }
  return { version: 1, axis, scope, key: value.key };
}

function encodeStudentDetailRef(
  academicYearId: AcademicYearId,
  classGroupId: ClassGroupId,
  detailKey: string,
): PerformanceStudentDetailRefV1 {
  return encodeToken(STUDENT_DETAIL_PREFIX, {
    version: 1,
    academicYearId,
    classGroupId,
    detailKey,
  }) as PerformanceStudentDetailRefV1;
}

export function decodeStudentDetailRef(
  detailRef: PerformanceStudentDetailRefV1,
): StudentDetailPayloadV1 | null {
  const value = decodeToken(STUDENT_DETAIL_PREFIX, detailRef);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'academicYearId', 'classGroupId', 'detailKey']) ||
    value.version !== 1 ||
    typeof value.academicYearId !== 'string' ||
    value.academicYearId.trim().length === 0 ||
    typeof value.classGroupId !== 'string' ||
    value.classGroupId.trim().length === 0 ||
    typeof value.detailKey !== 'string' ||
    value.detailKey.trim().length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    academicYearId: value.academicYearId,
    classGroupId: value.classGroupId,
    detailKey: value.detailKey,
  };
}

function encodeCellDetailRef(scope: string, detailKey: string): PerformanceCellDetailRefV1 {
  return encodeToken(CELL_DETAIL_PREFIX, {
    version: 1,
    scope,
    detailKey,
  }) as PerformanceCellDetailRefV1;
}

export function decodeCellDetailRef(
  detailRef: PerformanceCellDetailRefV1,
): (CellDetailPayloadV1 & { readonly request: PerformanceMatrixSourceRequestV1 }) | null {
  const value = decodeToken(CELL_DETAIL_PREFIX, detailRef);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'scope', 'detailKey']) ||
    value.version !== 1 ||
    typeof value.scope !== 'string' ||
    typeof value.detailKey !== 'string' ||
    value.detailKey.trim().length === 0
  ) {
    return null;
  }
  const request = parseScope(value.scope);
  return request === null
    ? null
    : { version: 1, scope: value.scope, detailKey: value.detailKey, request };
}

function cloneGrade(value: AcademicGradeValueV1): AcademicGradeValueV1 {
  switch (value.state) {
    case 'absent':
      return { state: 'absent' };
    case 'numeric':
      if (!Number.isFinite(value.value)) return fail('incompatible-source-result');
      return { state: 'numeric', value: value.value };
    case 'official-zero':
      if (value.value !== 0 || value.sourceMarker !== 0.1 /* NOSONAR: exact source marker */) {
        return fail('incompatible-source-result');
      }
      return { state: 'official-zero', value: 0, sourceMarker: 0.1 };
    case 'legacy-zero':
      if (value.value !== 0) return fail('incompatible-source-result');
      return { state: 'legacy-zero', value: 0 };
    case 'not-applicable':
      return value.reason === undefined
        ? { state: 'not-applicable' }
        : { state: 'not-applicable', reason: value.reason };
    case 'insufficient-data':
      return { state: 'insufficient-data', reason: requireNonEmpty(value.reason) };
    default:
      return fail('incompatible-source-result');
  }
}

function cloneApplicability(value: ApplicabilityV1): ApplicabilityV1 {
  switch (value.state) {
    case 'applicable':
      return { state: 'applicable' };
    case 'not-applicable':
      return value.reason === undefined
        ? { state: 'not-applicable' }
        : { state: 'not-applicable', reason: value.reason };
    case 'insufficient-data':
      return { state: 'insufficient-data', reason: requireNonEmpty(value.reason) };
    default:
      return fail('incompatible-source-result');
  }
}

function cloneComparedGrade(
  value: PerformanceComparedGradeValueV1,
): PerformanceComparedGradeValueV1 {
  return {
    imported: cloneGrade(value.imported),
    calculated: cloneGrade(value.calculated),
  };
}

function cloneComparedApplicability(
  value: PerformanceComparedApplicabilityV1,
): PerformanceComparedApplicabilityV1 {
  return {
    imported: cloneApplicability(value.imported),
    calculated: cloneApplicability(value.calculated),
  };
}

function cloneCoverage(value: ResultCoverageV1): ResultCoverageV1 {
  if (
    !RESULT_COVERAGE_STATES_V1.includes(value.state) ||
    !Number.isInteger(value.expectedItemCount) ||
    !Number.isInteger(value.resolvedItemCount) ||
    !Number.isInteger(value.missingItemCount) ||
    value.expectedItemCount < 0 ||
    value.resolvedItemCount < 0 ||
    value.missingItemCount < 0 ||
    value.resolvedItemCount + value.missingItemCount !== value.expectedItemCount ||
    !Array.isArray(value.reasons) ||
    value.reasons.some((reason) => typeof reason !== 'string' || reason.trim().length === 0)
  ) {
    return fail('incompatible-source-result');
  }
  return {
    state: value.state,
    expectedItemCount: value.expectedItemCount,
    resolvedItemCount: value.resolvedItemCount,
    missingItemCount: value.missingItemCount,
    reasons: [...value.reasons],
  };
}

function cloneComparisonConfiguration(
  value: PerformanceComparisonConfigurationV1,
): PerformanceComparisonConfigurationV1 {
  if (
    value.key !== PERFORMANCE_COMPARISON_CONFIGURATION_KEY_V1 ||
    value.scope !== PERFORMANCE_COMPARISON_CONFIGURATION_SCOPE_V1
  ) {
    return fail('incompatible-source-result');
  }
  if (value.source === 'canonical-default') {
    if (
      value.enabled !== true ||
      value.platformConfigurationId !== null ||
      value.version !== null ||
      value.effectiveFrom !== null ||
      value.effectiveUntil !== null ||
      value.updatedAt !== null
    ) {
      return fail('incompatible-source-result');
    }
    return { ...value };
  }
  if (
    value.source !== 'platform-configuration' ||
    typeof value.enabled !== 'boolean' ||
    requireNonEmpty(value.platformConfigurationId).length === 0 ||
    requireNonEmpty(value.version).length === 0 ||
    typeof value.effectiveFrom !== 'string' ||
    typeof value.effectiveUntil !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return fail('incompatible-source-result');
  }
  return { ...value };
}

function cloneComparisonProfile(
  value: PerformanceComparisonProfileRefV2,
): PerformanceComparisonProfileRefV2 {
  return {
    profileId: requireNonEmpty(value.profileId),
    profileVersion: requireNonEmpty(value.profileVersion),
    percentageSemanticsVersion: requireNonEmpty(value.percentageSemanticsVersion),
  };
}

function cloneProfileCompatibility(
  value: PerformanceProfileCompatibilityV2,
): PerformanceProfileCompatibilityV2 {
  const currentProfile = cloneComparisonProfile(value.currentProfile);
  const referenceProfile = cloneComparisonProfile(value.referenceProfile);
  if (value.state === 'not-compatible') {
    if (
      value.reason !== 'profile-semantics-not-declared-compatible' ||
      (value.ruleVersion !== null && value.ruleVersion.trim().length === 0)
    ) {
      return fail('incompatible-source-result');
    }
    return { ...value, currentProfile, referenceProfile };
  }
  if (
    value.state !== 'compatible' ||
    !['same-profile-semantics', 'declared-cross-profile-compatibility'].includes(value.source)
  ) {
    return fail('incompatible-source-result');
  }
  return {
    ...value,
    ruleVersion: requireNonEmpty(value.ruleVersion),
    currentProfile,
    referenceProfile,
  };
}

function cloneProportionalComparison(
  value: PerformanceComparisonProjectionV2,
  request: PerformanceMatrixSourceRequestV1,
): PerformanceComparisonProjectionV2 {
  const configuration = cloneComparisonConfiguration(value.configuration);
  if (value.state === 'not-requested') {
    if (request.comparisonPeriod !== null) return fail('incompatible-source-result');
    return { state: 'not-requested', configuration };
  }
  if (
    request.comparisonPeriod === null ||
    !samePeriod(value.selection.current, request.period) ||
    !samePeriod(value.selection.reference, request.comparisonPeriod)
  ) {
    return fail('incompatible-source-result');
  }
  const selection = {
    current: clonePeriod(value.selection.current),
    reference: clonePeriod(value.selection.reference),
  };
  if (value.state === 'disabled') {
    if (configuration.enabled) return fail('incompatible-source-result');
    return { state: 'disabled', selection, configuration };
  }
  if (value.state !== 'resolved' || !configuration.enabled) {
    return fail('incompatible-source-result');
  }
  const comparison = value.comparison;
  const current = {
    period: clonePeriod(comparison.current.period),
    percentage: cloneGrade(comparison.current.percentage),
    coverage: cloneCoverage(comparison.current.coverage),
  };
  const reference = {
    period: clonePeriod(comparison.reference.period),
    percentage: cloneGrade(comparison.reference.percentage),
    coverage: cloneCoverage(comparison.reference.coverage),
  };
  if (
    comparison.basis !== 'percentage' ||
    !samePeriod(current.period, selection.current) ||
    !samePeriod(reference.period, selection.reference)
  ) {
    return fail('incompatible-source-result');
  }
  const compatibility = cloneProfileCompatibility(comparison.compatibility);
  if (comparison.state === 'not-comparable') {
    return {
      state: 'resolved',
      selection,
      configuration,
      comparison: {
        state: 'not-comparable',
        basis: 'percentage',
        reason: comparison.reason,
        current,
        reference,
        compatibility,
      },
    };
  }
  if (
    comparison.state !== 'comparable' ||
    compatibility.state !== 'compatible' ||
    !PERFORMANCE_PROPORTIONAL_RELATIONS_V2.includes(comparison.relation)
  ) {
    return fail('incompatible-source-result');
  }
  return {
    state: 'resolved',
    selection,
    configuration,
    comparison: {
      state: 'comparable',
      basis: 'percentage',
      relation: comparison.relation,
      current,
      reference,
      compatibility,
    },
  };
}

function cloneComparison(
  value: PerformanceValueComparisonV1 | null,
  comparisonPeriod: PerformancePeriodV1 | null,
): PerformanceValueComparisonV1 | null {
  if (comparisonPeriod === null) {
    if (value !== null) return fail('incompatible-source-result');
    return null;
  }
  if (value === null || !samePeriod(value.referencePeriod, comparisonPeriod)) {
    return fail('incompatible-source-result');
  }
  if (value.state === 'not-comparable') {
    return {
      state: 'not-comparable',
      referencePeriod: clonePeriod(value.referencePeriod),
      reason: requireNonEmpty(value.reason),
    };
  }
  if (value.state !== 'comparable' || !['official-value', 'percentage'].includes(value.basis)) {
    return fail('incompatible-source-result');
  }
  return {
    state: 'comparable',
    referencePeriod: clonePeriod(value.referencePeriod),
    basis: value.basis,
    current: cloneComparedGrade(value.current),
    reference: cloneComparedGrade(value.reference),
  };
}

function cloneResultProjection(
  value: PerformanceResultProjectionV1,
): PerformanceResultProjectionV1 {
  switch (value.source) {
    case 'term-result':
      return {
        source: 'term-result',
        officialGrade: cloneComparedGrade(value.officialGrade),
        percentage: cloneComparedGrade(value.percentage),
      };
    case 'final-recovery':
      return {
        source: 'final-recovery',
        originalTermGrade: cloneComparedGrade(value.originalTermGrade),
        applicability: cloneComparedApplicability(value.applicability),
        recoveryGrade: cloneComparedGrade(value.recoveryGrade),
        replacementTermGrade: cloneComparedGrade(value.replacementTermGrade),
      };
    case 'annual-result':
      if (
        !ACADEMIC_RESULT_STATES_V1.includes(value.academicState.imported) ||
        !ACADEMIC_RESULT_STATES_V1.includes(value.academicState.calculated)
      ) {
        return fail('incompatible-source-result');
      }
      return {
        source: 'annual-result',
        originalTotal: cloneComparedGrade(value.originalTotal),
        postRecoveryTotal: cloneComparedGrade(value.postRecoveryTotal),
        academicState: {
          imported: value.academicState.imported,
          calculated: value.academicState.calculated,
        },
      };
    default:
      return fail('incompatible-source-result');
  }
}

function cloneQuantitativeProjection(
  value: PerformanceQuantitativeProjectionV1,
): PerformanceQuantitativeProjectionV1 {
  return {
    original: cloneComparedGrade(value.original),
    parallelRecovery: cloneComparedGrade(value.parallelRecovery),
    parallelRecoveryApplicability: cloneComparedApplicability(value.parallelRecoveryApplicability),
    considered: cloneComparedGrade(value.considered),
  };
}

function cloneQualitativeProjection(
  value: PerformanceQualitativeProjectionV1,
): PerformanceQualitativeProjectionV1 {
  return { operational: cloneComparedGrade(value.operational) };
}

function compareAssessmentValues(
  left: PerformanceAssessmentValueV1,
  right: PerformanceAssessmentValueV1,
): number {
  return (
    left.order - right.order || (left.assessmentComponentId < right.assessmentComponentId ? -1 : 1)
  );
}

function validAssessmentMaximum(value: unknown): value is PerformanceAssessmentValueV1['maximum'] {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.state === 'not-defined') return Object.keys(candidate).length === 1;
  return (
    candidate.state === 'defined' &&
    Object.keys(candidate).length === 2 &&
    typeof candidate.value === 'number' &&
    Number.isFinite(candidate.value) &&
    candidate.value > 0
  );
}

function cloneAssessmentsProjection(
  value: PerformanceAssessmentsProjectionV1,
): PerformanceAssessmentsProjectionV1 {
  const seen = new Set<string>();
  const items = value.items.map((item): PerformanceAssessmentValueV1 => {
    requireNonEmpty(item.assessmentComponentId);
    requireNonEmpty(item.name);
    if (
      seen.has(item.assessmentComponentId) ||
      ![
        'written',
        'simulation',
        'quantitative-assessment',
        'qualitative-activity',
        'parallel-recovery',
      ].includes(item.type) ||
      !Number.isInteger(item.order) ||
      item.order < 0 ||
      !validAssessmentMaximum(item.maximum)
    ) {
      return fail('incompatible-source-result');
    }
    seen.add(item.assessmentComponentId);
    return {
      assessmentComponentId: item.assessmentComponentId,
      name: item.name,
      type: item.type,
      order: item.order,
      maximum: item.maximum,
      applicability: cloneApplicability(item.applicability),
      value: cloneComparedGrade(item.value),
    };
  });
  return { items: items.sort(compareAssessmentValues) };
}

function signalDetailRef(detail: unknown, detailRef: PerformanceCellDetailRefV1) {
  if (detail === 'cell') return detailRef;
  return detail === 'none' ? null : fail('incompatible-source-result');
}

function cloneSignals(
  values: readonly PerformanceSourceSignalV1[],
  detailRef: PerformanceCellDetailRefV1,
): readonly PerformanceSignalV1[] {
  return values
    .map((signal): PerformanceSignalV1 => {
      if (!['official-result', 'coverage', 'comparison'].includes(signal.source)) {
        return fail('incompatible-source-result');
      }
      return {
        code: requireNonEmpty(signal.code),
        explanation: requireNonEmpty(signal.explanation),
        source: signal.source,
        detailRef: signalDetailRef(signal.detail, detailRef),
      };
    })
    .sort((left, right) => {
      if (left.code < right.code) {
        return -1;
      }
      if (left.code > right.code) {
        return 1;
      }
      if (left.explanation < right.explanation) {
        return -1;
      }
      if (left.explanation > right.explanation) {
        return 1;
      }
      return 0;
    });
}

function cloneCell(
  source: PerformanceMatrixSourceCellV1,
  request: PerformanceMatrixSourceRequestV1,
  detailRef: PerformanceCellDetailRefV1,
): PerformanceCellV1 {
  if (
    source.lens !== request.lens ||
    source.authorityMode !== PERFORMANCE_AUTHORITY_MODE_V1 ||
    source.teachingAssignmentId.trim().length === 0
  ) {
    return fail('incompatible-source-result');
  }
  const base = {
    teachingAssignmentId: source.teachingAssignmentId,
    authorityMode: PERFORMANCE_AUTHORITY_MODE_V1,
    coverage: cloneCoverage(source.coverage),
    comparison: cloneComparison(source.comparison, request.comparisonPeriod),
    signals: cloneSignals(source.signals, detailRef),
    detailRef,
    ...(source.proportionalComparison === undefined
      ? {}
      : {
          proportionalComparison: cloneProportionalComparison(
            source.proportionalComparison,
            request,
          ),
        }),
  } as const;
  switch (source.lens) {
    case 'result':
      return { ...base, lens: 'result', projection: cloneResultProjection(source.projection) };
    case 'quantitative':
      return {
        ...base,
        lens: 'quantitative',
        projection: cloneQuantitativeProjection(source.projection),
      };
    case 'qualitative':
      return {
        ...base,
        lens: 'qualitative',
        projection: cloneQualitativeProjection(source.projection),
      };
    case 'assessments':
      return {
        ...base,
        lens: 'assessments',
        projection: cloneAssessmentsProjection(source.projection),
      };
  }
}

function cloneSituation(value: PerformanceStudentSituationV1): PerformanceStudentSituationV1 {
  if (value.state === 'absent') return { state: 'absent' };
  if (
    value.state !== 'known' ||
    !['active', 'transferred', 'withdrawn', 'deceased', 'other'].includes(value.value)
  ) {
    return fail('incompatible-source-result');
  }
  return { state: 'known', value: value.value };
}

function assertSnapshotMatches(
  snapshot: PerformanceMatrixSourceSnapshotV1,
  request: PerformanceMatrixSourceRequestV1,
): void {
  if (
    snapshot.contractVersion !== CLASS_PERFORMANCE_CONTRACT_VERSION_V1 ||
    snapshot.academicYearId !== request.academicYearId ||
    snapshot.classGroupId !== request.classGroupId ||
    !samePeriod(snapshot.period, request.period) ||
    snapshot.mode !== request.mode ||
    snapshot.lens !== request.lens ||
    !sameOptionalPeriod(snapshot.comparisonPeriod, request.comparisonPeriod) ||
    snapshot.authorityMode !== PERFORMANCE_AUTHORITY_MODE_V1 ||
    !Array.isArray(snapshot.columns) ||
    !Array.isArray(snapshot.rows)
  ) {
    fail('incompatible-source-result');
  }
}

function canonicalColumns(
  source: readonly PerformanceComponentColumnV1[],
): readonly PerformanceComponentColumnV1[] {
  const seen = new Set<string>();
  return source
    .map((column): PerformanceComponentColumnV1 => {
      if (seen.has(column.teachingAssignmentId)) return fail('incompatible-source-result');
      seen.add(requireNonEmpty(column.teachingAssignmentId));
      return {
        teachingAssignmentId: column.teachingAssignmentId,
        subjectId: requireNonEmpty(column.subjectId) as PerformanceComponentColumnV1['subjectId'],
        code: requireNonEmpty(column.code),
        displayName: requireNonEmpty(column.displayName),
      };
    })
    .sort(comparePerformanceComponentColumnsV1);
}

interface CanonicalSourceRowV1 {
  readonly sourcePosition: number | null;
  readonly studentId: StudentId;
  readonly displayName: string;
  readonly situation: PerformanceStudentSituationV1;
  readonly detailKey: string;
  readonly cells: ReadonlyMap<TeachingAssignmentId, PerformanceMatrixSourceCellV1>;
}

function canonicalRows(
  source: readonly PerformanceMatrixSourceRowV1[],
  columns: readonly PerformanceComponentColumnV1[],
): readonly CanonicalSourceRowV1[] {
  const columnIds = new Set(columns.map((column) => column.teachingAssignmentId));
  const seenStudents = new Set<string>();
  const seenStudentDetails = new Set<string>();
  const seenCellDetails = new Set<string>();
  const rows = source.map((row): CanonicalSourceRowV1 => {
    if (
      seenStudents.has(row.studentId) ||
      seenStudentDetails.has(row.detailKey) ||
      (row.sourcePosition !== null &&
        (!Number.isInteger(row.sourcePosition) || row.sourcePosition <= 0))
    ) {
      return fail('incompatible-source-result');
    }
    seenStudents.add(requireNonEmpty(row.studentId));
    seenStudentDetails.add(requireNonEmpty(row.detailKey));
    const cells = new Map<TeachingAssignmentId, PerformanceMatrixSourceCellV1>();
    for (const cell of row.cells) {
      if (
        !columnIds.has(cell.teachingAssignmentId) ||
        cells.has(cell.teachingAssignmentId) ||
        seenCellDetails.has(cell.detailKey)
      ) {
        return fail('incompatible-source-result');
      }
      requireNonEmpty(cell.detailKey);
      cells.set(cell.teachingAssignmentId, cell);
      seenCellDetails.add(cell.detailKey);
    }
    if (cells.size !== columns.length) return fail('incompatible-source-result');
    return {
      sourcePosition: row.sourcePosition,
      studentId: row.studentId,
      displayName: requireNonEmpty(row.displayName),
      situation: cloneSituation(row.situation),
      detailKey: row.detailKey,
      cells,
    };
  });
  return rows.sort((left, right) =>
    comparePerformanceStudentRowsV1(
      { ...left, detailRef: '' as PerformanceStudentDetailRefV1, cells: [] },
      { ...right, detailRef: '' as PerformanceStudentDetailRefV1, cells: [] },
    ),
  );
}

function pageStart<Keyed extends { readonly key: string }>(
  items: readonly Keyed[],
  cursor: string | null,
  axis: CursorPayloadV1['axis'],
  scope: string,
): number {
  if (cursor === null) return 0;
  const decoded = decodeCursor(axis, scope, cursor);
  if (decoded === null) {
    return fail(axis === 'rows' ? 'invalid-row-cursor' : 'invalid-column-cursor');
  }
  const index = items.findIndex((item) => item.key === decoded.key);
  if (index < 0) return fail(axis === 'rows' ? 'invalid-row-cursor' : 'invalid-column-cursor');
  return index + 1;
}

function cloneStudent(value: StudentV1): StudentV1 {
  return {
    id: value.id,
    displayName: requireNonEmpty(value.displayName),
    sourceNames: [...value.sourceNames],
    ...(value.sourceIdentityMarks === undefined
      ? {}
      : { sourceIdentityMarks: [...value.sourceIdentityMarks] }),
  };
}

function cloneEnrollment(value: EnrollmentV1): EnrollmentV1 {
  return {
    id: value.id,
    academicYearId: value.academicYearId,
    studentId: value.studentId,
    classGroupId: value.classGroupId,
    effectivePeriod: { ...value.effectivePeriod },
    position: value.position,
    ...(value.sourcePosition === undefined ? {} : { sourcePosition: value.sourcePosition }),
  };
}

function cloneStatusEvent(value: StudentStatusEventV1): StudentStatusEventV1 {
  return {
    id: value.id,
    academicYearId: value.academicYearId,
    enrollmentId: value.enrollmentId,
    status: value.status,
    sourceText: value.sourceText,
    ...(value.occurredOn === undefined ? {} : { occurredOn: value.occurredOn }),
    ...(value.sourceReference === undefined ? {} : { sourceReference: value.sourceReference }),
    ...(value.importBatchId === undefined ? {} : { importBatchId: value.importBatchId }),
    ...(value.transfer === undefined ? {} : { transfer: { ...value.transfer } }),
  };
}

function validateOfficialRecords(
  records: readonly AcademicRecordV1[],
  request: PerformanceMatrixSourceRequestV1,
  studentId: StudentId,
  teachingAssignmentId: TeachingAssignmentId,
): readonly AcademicRecordV1[] {
  if (!Array.isArray(records)) return fail('incompatible-source-result');
  for (const record of records) {
    const value = record.value;
    if (
      value.academicYearId !== request.academicYearId ||
      value.studentId !== studentId ||
      value.authorityMode !== PERFORMANCE_AUTHORITY_MODE_V1
    ) {
      return fail('incompatible-source-result');
    }
    if (record.kind !== 'grade-entry' && value.teachingAssignmentId !== teachingAssignmentId) {
      return fail('incompatible-source-result');
    }
  }
  return [...records];
}

async function callSource<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return fail('source-failure');
  }
}

export function createClassPerformanceReadModelV1(
  source: ClassPerformanceSourceV1,
): ClassPerformanceReadModelProviderV1 {
  return Object.freeze({
    async get(request: ClassPerformanceRequestV1): Promise<ClassPerformanceReadModelV1 | null> {
      if (inspectClassPerformanceRequestV1(request) !== 'ready') return fail('invalid-request');
      const sourceRequest = matrixSourceRequest(request);
      const snapshot = await callSource(() => source.loadMatrix(sourceRequest));
      if (snapshot === null) return null;
      assertSnapshotMatches(snapshot, sourceRequest);

      const scope = scopeFor(sourceRequest);
      const columns = canonicalColumns(snapshot.columns);
      const rows = canonicalRows(snapshot.rows, columns);
      const columnKeys = columns.map((column) => ({ key: column.teachingAssignmentId, column }));
      const rowKeys = rows.map((row) => ({ key: row.studentId, row }));
      const columnStart = pageStart(columnKeys, request.columns.cursor, 'columns', scope);
      const rowStart = pageStart(rowKeys, request.rows.cursor, 'rows', scope);
      const selectedColumns = columnKeys.slice(columnStart, columnStart + request.columns.limit);
      const selectedRows = rowKeys.slice(rowStart, rowStart + request.rows.limit);
      const lastColumn = selectedColumns.at(-1);
      const lastRow = selectedRows.at(-1);

      const model: ClassPerformanceReadModelV1 = {
        contractVersion: CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
        academicYearId: sourceRequest.academicYearId,
        classGroupId: sourceRequest.classGroupId,
        period: clonePeriod(sourceRequest.period),
        mode: sourceRequest.mode,
        lens: sourceRequest.lens,
        comparisonPeriod: cloneOptionalPeriod(sourceRequest.comparisonPeriod),
        authorityMode: PERFORMANCE_AUTHORITY_MODE_V1,
        coverage: cloneCoverage(snapshot.coverage),
        order: {
          rows: PERFORMANCE_ROW_ORDER_V1,
          columns: PERFORMANCE_COLUMN_ORDER_V1,
        },
        columns: {
          limit: request.columns.limit,
          items: selectedColumns.map(({ column }) => column),
          nextCursor:
            columnStart + selectedColumns.length < columns.length && lastColumn !== undefined
              ? (encodeCursor('columns', scope, lastColumn.key) as PerformanceColumnCursorV1)
              : null,
        },
        rows: {
          limit: request.rows.limit,
          items: selectedRows.map(({ row }) => ({
            sourcePosition: row.sourcePosition,
            studentId: row.studentId,
            displayName: row.displayName,
            situation: row.situation,
            detailRef: encodeStudentDetailRef(
              sourceRequest.academicYearId,
              sourceRequest.classGroupId,
              row.detailKey,
            ),
            cells: selectedColumns.map(({ column }) => {
              const cell = row.cells.get(column.teachingAssignmentId);
              if (cell === undefined) return fail('incompatible-source-result');
              const detailRef = encodeCellDetailRef(scope, cell.detailKey);
              return cloneCell(cell, sourceRequest, detailRef);
            }),
          })),
          nextCursor:
            rowStart + selectedRows.length < rows.length && lastRow !== undefined
              ? (encodeCursor('rows', scope, lastRow.key) as PerformanceRowCursorV1)
              : null,
        },
      };

      return isClassPerformanceReadModelValidV1(model) ? model : fail('incompatible-source-result');
    },

    async getStudentDetail(
      detailRef: PerformanceStudentDetailRefV1,
    ): Promise<PerformanceStudentDetailV1 | null> {
      const decoded = decodeStudentDetailRef(detailRef);
      if (decoded === null) return fail('invalid-detail-reference');
      const request: PerformanceStudentDetailSourceRequestV1 = {
        academicYearId: decoded.academicYearId as AcademicYearId,
        classGroupId: decoded.classGroupId as ClassGroupId,
        detailKey: decoded.detailKey,
      };
      const detail = await callSource(() => source.loadStudentDetail(request));
      if (detail === null) return null;
      if (
        detail.academicYearId !== request.academicYearId ||
        detail.classGroupId !== request.classGroupId ||
        detail.detailKey !== request.detailKey ||
        detail.enrollment.academicYearId !== request.academicYearId ||
        detail.enrollment.classGroupId !== request.classGroupId ||
        (detail.student !== null && detail.student.id !== detail.enrollment.studentId) ||
        detail.statusHistory.some(
          (event) =>
            event.academicYearId !== request.academicYearId ||
            event.enrollmentId !== detail.enrollment.id,
        )
      ) {
        return fail('incompatible-source-result');
      }
      return {
        detailRef,
        academicYearId: request.academicYearId,
        classGroupId: request.classGroupId,
        student: detail.student === null ? null : cloneStudent(detail.student),
        enrollment: cloneEnrollment(detail.enrollment),
        statusHistory: detail.statusHistory.map(cloneStatusEvent),
      };
    },

    async getCellDetail(
      detailRef: PerformanceCellDetailRefV1,
    ): Promise<PerformanceCellDetailV1 | null> {
      const decoded = decodeCellDetailRef(detailRef);
      if (decoded === null) return fail('invalid-detail-reference');
      const request: PerformanceCellDetailSourceRequestV1 = {
        ...decoded.request,
        detailKey: decoded.detailKey,
      };
      const detail = await callSource(() => source.loadCellDetail(request));
      if (detail === null) return null;
      if (
        detail.contractVersion !== CLASS_PERFORMANCE_CONTRACT_VERSION_V1 ||
        detail.detailKey !== request.detailKey ||
        detail.academicYearId !== request.academicYearId ||
        detail.classGroupId !== request.classGroupId ||
        !samePeriod(detail.period, request.period) ||
        detail.mode !== request.mode ||
        detail.lens !== request.lens ||
        !sameOptionalPeriod(detail.comparisonPeriod, request.comparisonPeriod) ||
        detail.studentId.trim().length === 0
      ) {
        return fail('incompatible-source-result');
      }
      const cell = cloneCell(detail.cell, request, detailRef);
      return {
        ...request,
        detailRef,
        studentId: detail.studentId,
        authorityMode: PERFORMANCE_AUTHORITY_MODE_V1,
        cell,
        officialRecords: validateOfficialRecords(
          detail.officialRecords,
          request,
          detail.studentId,
          cell.teachingAssignmentId,
        ),
      };
    },
  });
}

export const createClassPerformanceReadModelProviderV1 = createClassPerformanceReadModelV1;

/** Inspect an already structurally validated request without loading a snapshot.
 * Retirement preserves syntax and scope checks, not existence checks on source keys.
 */
export function inspectPerformanceCursorsV1(
  request: ClassPerformanceRequestV1,
): 'invalid-row-cursor' | 'invalid-column-cursor' | null {
  const scope = scopeFor(matrixSourceRequest(request));
  for (const axis of ['columns', 'rows'] as const) {
    const cursor = request[axis].cursor;
    if (cursor !== null && decodeCursor(axis, scope, cursor) === null) {
      return axis === 'rows' ? 'invalid-row-cursor' : 'invalid-column-cursor';
    }
  }
  return null;
}
