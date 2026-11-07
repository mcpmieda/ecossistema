import { compareCanonicalStringsV1 } from '../string-order-v1';
import type {
  AcademicYearId,
  ClassGroupId,
  StudentId,
  StudentStatusV1,
  SubjectId,
  TeachingAssignmentId,
} from '../entities';
import {
  ACADEMIC_TERMS_V1,
  RESULT_COVERAGE_STATES_V1,
  type AcademicGradeValueV1,
  type AcademicTermV1,
  type ApplicabilityV1,
  type AssessmentComponentId,
  type AssessmentComponentTypeV1,
  type AuthorityModeV1,
  type ComparedAcademicStateV1,
  type ResultCoverageV1,
} from '../results/results-contract-v1';
import type { AssessmentComponentTypeV2 } from '../results/results-contract-v2';
import type { AssessmentMaximumV3 } from '../results/results-contract-v3';

export const CLASS_PERFORMANCE_CONTRACT_VERSION_V1 = 1 as const;

export const PERFORMANCE_LENSES_V1 = [
  'result',
  'quantitative',
  'qualitative',
  'assessments',
] as const;
export type PerformanceLensV1 = (typeof PERFORMANCE_LENSES_V1)[number];

export const PERFORMANCE_MODES_V1 = ['regular', 'recovery'] as const;
export type PerformanceModeV1 = (typeof PERFORMANCE_MODES_V1)[number];

const PERFORMANCE_PERIOD_KINDS_V1 = ['term', 'annual'] as const;

export type PerformancePeriodV1 =
  | {
      readonly kind: 'term';
      readonly term: AcademicTermV1;
    }
  | {
      readonly kind: 'annual';
    };

export const PERFORMANCE_COMPARABILITY_STATES_V1 = ['comparable', 'not-comparable'] as const;

export const PERFORMANCE_COMPARISON_BASES_V1 = ['official-value', 'percentage'] as const;
export type PerformanceComparisonBasisV1 = (typeof PERFORMANCE_COMPARISON_BASES_V1)[number];

const PERFORMANCE_MIN_PAGE_LIMIT_V1 = 1 as const;
export const PERFORMANCE_MAX_PAGE_LIMIT_V1 = 100 as const;
export const PERFORMANCE_ROW_ORDER_V1 =
  'source-position-display-name-student-id-ascending-code-unit' as const;
export const PERFORMANCE_COLUMN_ORDER_V1 =
  'subject-code-display-name-assignment-id-ascending-code-unit' as const;

export type PerformanceAuthorityModeV1 = Extract<AuthorityModeV1, 'imported-source'>;
export const PERFORMANCE_AUTHORITY_MODE_V1 = 'imported-source' satisfies PerformanceAuthorityModeV1;

declare const performanceRowCursorBrand: unique symbol;
declare const performanceColumnCursorBrand: unique symbol;
declare const performanceStudentDetailRefBrand: unique symbol;
declare const performanceCellDetailRefBrand: unique symbol;

/** Opaque continuation value issued and consumed only by a performance read-model implementation. */
export type PerformanceRowCursorV1 = string & {
  readonly [performanceRowCursorBrand]: 'PerformanceRowCursorV1';
};

/** Opaque continuation value issued and consumed only by a performance read-model implementation. */
export type PerformanceColumnCursorV1 = string & {
  readonly [performanceColumnCursorBrand]: 'PerformanceColumnCursorV1';
};

/** Opaque reference used to request student detail without embedding another entity model. */
export type PerformanceStudentDetailRefV1 = string & {
  readonly [performanceStudentDetailRefBrand]: 'PerformanceStudentDetailRefV1';
};

/** Opaque reference used to request cell detail without embedding raw source evidence in the matrix. */
export type PerformanceCellDetailRefV1 = string & {
  readonly [performanceCellDetailRefBrand]: 'PerformanceCellDetailRefV1';
};

export interface PerformancePageRequestV1<Cursor extends string> {
  readonly limit: number;
  readonly cursor: Cursor | null;
}

/**
 * Provider-independent request. Academic rules and authority selection are deliberately absent:
 * the read model projects already-resolved official contracts and cannot accept a competing rule.
 */
export interface ClassPerformanceRequestV1 {
  readonly contractVersion: typeof CLASS_PERFORMANCE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly period: PerformancePeriodV1;
  readonly mode: PerformanceModeV1;
  readonly lens: PerformanceLensV1;
  readonly comparisonPeriod: PerformancePeriodV1 | null;
  readonly rows: PerformancePageRequestV1<PerformanceRowCursorV1>;
  readonly columns: PerformancePageRequestV1<PerformanceColumnCursorV1>;
  readonly order: {
    readonly rows: typeof PERFORMANCE_ROW_ORDER_V1;
    readonly columns: typeof PERFORMANCE_COLUMN_ORDER_V1;
  };
}

/**
 * Minimal projection of the official dual-sided grade value. Source evidence remains available
 * through the owning academic record/audit contracts and is intentionally not copied here.
 */
export interface PerformanceComparedGradeValueV1 {
  readonly imported: AcademicGradeValueV1;
  readonly calculated: AcademicGradeValueV1;
}

/** Same dual-sided projection for applicability, without copying imported source evidence. */
export interface PerformanceComparedApplicabilityV1 {
  readonly imported: ApplicabilityV1;
  readonly calculated: ApplicabilityV1;
}

export type PerformanceStudentSituationV1 =
  | {
      readonly state: 'known';
      readonly value: StudentStatusV1;
    }
  | {
      readonly state: 'absent';
    };

export interface PerformanceComponentColumnV1 {
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly subjectId: SubjectId;
  readonly code: string;
  readonly displayName: string;
}

export interface PerformanceSignalV1 {
  readonly code: string;
  readonly explanation: string;
  readonly source: 'official-result' | 'coverage' | 'comparison';
  readonly detailRef: PerformanceCellDetailRefV1 | null;
}

export type PerformanceValueComparisonV1 =
  | {
      readonly state: 'comparable';
      readonly referencePeriod: PerformancePeriodV1;
      readonly basis: PerformanceComparisonBasisV1;
      readonly current: PerformanceComparedGradeValueV1;
      readonly reference: PerformanceComparedGradeValueV1;
    }
  | {
      readonly state: 'not-comparable';
      readonly referencePeriod: PerformancePeriodV1;
      readonly reason: string;
    };

export type PerformanceResultProjectionV1 =
  | {
      readonly source: 'term-result';
      readonly officialGrade: PerformanceComparedGradeValueV1;
      readonly percentage: PerformanceComparedGradeValueV1;
    }
  | {
      readonly source: 'final-recovery';
      readonly originalTermGrade: PerformanceComparedGradeValueV1;
      readonly applicability: PerformanceComparedApplicabilityV1;
      readonly recoveryGrade: PerformanceComparedGradeValueV1;
      readonly replacementTermGrade: PerformanceComparedGradeValueV1;
    }
  | {
      readonly source: 'annual-result';
      readonly originalTotal: PerformanceComparedGradeValueV1;
      readonly postRecoveryTotal: PerformanceComparedGradeValueV1;
      readonly academicState: ComparedAcademicStateV1;
    };

export interface PerformanceQuantitativeProjectionV1 {
  readonly original: PerformanceComparedGradeValueV1;
  readonly parallelRecovery: PerformanceComparedGradeValueV1;
  readonly parallelRecoveryApplicability: PerformanceComparedApplicabilityV1;
  readonly considered: PerformanceComparedGradeValueV1;
}

export interface PerformanceQualitativeProjectionV1 {
  readonly operational: PerformanceComparedGradeValueV1;
}

export interface PerformanceAssessmentValueV1 {
  readonly assessmentComponentId: AssessmentComponentId;
  readonly name: string;
  readonly type: AssessmentComponentTypeV1 | AssessmentComponentTypeV2;
  readonly order: number;
  /** Historical V1/V2 components use a number; V3 preserves an explicit not-defined state. */
  readonly maximum: number | AssessmentMaximumV3;
  readonly applicability: ApplicabilityV1;
  readonly value: PerformanceComparedGradeValueV1;
}

export interface PerformanceAssessmentsProjectionV1 {
  readonly items: readonly PerformanceAssessmentValueV1[];
}

interface PerformanceCellBaseV1 {
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly authorityMode: PerformanceAuthorityModeV1;
  readonly coverage: ResultCoverageV1;
  readonly comparison: PerformanceValueComparisonV1 | null;
  readonly signals: readonly PerformanceSignalV1[];
  readonly detailRef: PerformanceCellDetailRefV1;
}

export type PerformanceCellV1 =
  | (PerformanceCellBaseV1 & {
      readonly lens: 'result';
      readonly projection: PerformanceResultProjectionV1;
    })
  | (PerformanceCellBaseV1 & {
      readonly lens: 'quantitative';
      readonly projection: PerformanceQuantitativeProjectionV1;
    })
  | (PerformanceCellBaseV1 & {
      readonly lens: 'qualitative';
      readonly projection: PerformanceQualitativeProjectionV1;
    })
  | (PerformanceCellBaseV1 & {
      readonly lens: 'assessments';
      readonly projection: PerformanceAssessmentsProjectionV1;
    });

export interface PerformanceStudentRowV1 {
  readonly sourcePosition: number | null;
  readonly studentId: StudentId;
  readonly displayName: string;
  readonly situation: PerformanceStudentSituationV1;
  readonly detailRef: PerformanceStudentDetailRefV1;
  readonly cells: readonly PerformanceCellV1[];
}

export interface PerformanceRowsPageV1 {
  readonly limit: number;
  readonly items: readonly PerformanceStudentRowV1[];
  readonly nextCursor: PerformanceRowCursorV1 | null;
}

export interface PerformanceColumnsPageV1 {
  readonly limit: number;
  readonly items: readonly PerformanceComponentColumnV1[];
  readonly nextCursor: PerformanceColumnCursorV1 | null;
}

/**
 * Read-only class performance matrix. It carries no total count, route, provider handle, academic
 * formula or raw source evidence. Every cell points to an opaque detail reference instead.
 */
export interface ClassPerformanceReadModelV1 {
  readonly contractVersion: typeof CLASS_PERFORMANCE_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly classGroupId: ClassGroupId;
  readonly period: PerformancePeriodV1;
  readonly mode: PerformanceModeV1;
  readonly lens: PerformanceLensV1;
  readonly comparisonPeriod: PerformancePeriodV1 | null;
  readonly authorityMode: PerformanceAuthorityModeV1;
  readonly coverage: ResultCoverageV1;
  readonly order: {
    readonly rows: typeof PERFORMANCE_ROW_ORDER_V1;
    readonly columns: typeof PERFORMANCE_COLUMN_ORDER_V1;
  };
  readonly rows: PerformanceRowsPageV1;
  readonly columns: PerformanceColumnsPageV1;
}

export const CLASS_PERFORMANCE_CONTRACT_V1 = {
  version: CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
  lenses: PERFORMANCE_LENSES_V1,
  modes: PERFORMANCE_MODES_V1,
  periodKinds: PERFORMANCE_PERIOD_KINDS_V1,
  coverageStates: RESULT_COVERAGE_STATES_V1,
  comparabilityStates: PERFORMANCE_COMPARABILITY_STATES_V1,
  comparisonBases: PERFORMANCE_COMPARISON_BASES_V1,
  authorityMode: PERFORMANCE_AUTHORITY_MODE_V1,
  order: {
    rows: PERFORMANCE_ROW_ORDER_V1,
    columns: PERFORMANCE_COLUMN_ORDER_V1,
  },
  pagination: {
    minimumLimit: PERFORMANCE_MIN_PAGE_LIMIT_V1,
    maximumLimit: PERFORMANCE_MAX_PAGE_LIMIT_V1,
    cursor: 'opaque',
    totalCount: 'omitted',
  },
  detail: {
    references: 'opaque',
    rawSourceEvidence: 'omitted-from-matrix',
  },
  academicSemantics: {
    source: 'shared-results-contract-v1',
    calculations: 'forbidden',
    rounding: 'forbidden',
    recoveryRules: 'forbidden',
    annualClassification: 'forbidden',
    tolerance: 'forbidden',
    signalStateMutation: 'forbidden',
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStringsV1);
  const expected = [...keys].sort(compareCanonicalStringsV1);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPerformancePageLimitV1(limit: number): boolean {
  return (
    Number.isInteger(limit) &&
    limit >= PERFORMANCE_MIN_PAGE_LIMIT_V1 &&
    limit <= PERFORMANCE_MAX_PAGE_LIMIT_V1
  );
}

export function isPerformancePeriodV1(value: unknown): value is PerformancePeriodV1 {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
  if (value.kind === 'annual') return hasExactKeys(value, ['kind']);
  if (value.kind !== 'term' || !hasExactKeys(value, ['kind', 'term'])) return false;
  return ACADEMIC_TERMS_V1.includes(value.term as AcademicTermV1);
}

function isPageRequestV1(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['limit', 'cursor'])) return false;
  if (typeof value.limit !== 'number' || !isPerformancePageLimitV1(value.limit)) return false;
  return value.cursor === null || isNonEmptyString(value.cursor);
}

function isOrderRequestV1(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['rows', 'columns']) &&
    value.rows === PERFORMANCE_ROW_ORDER_V1 &&
    value.columns === PERFORMANCE_COLUMN_ORDER_V1
  );
}

type ClassPerformanceRequestReadinessV1 = 'ready' | 'invalid-request';

/** Strict boundary inspection: extra fields are rejected, including client-side academic rules. */
export function inspectClassPerformanceRequestV1(
  request: unknown,
): ClassPerformanceRequestReadinessV1 {
  if (!isRecord(request)) return 'invalid-request';
  if (
    !hasExactKeys(request, [
      'contractVersion',
      'academicYearId',
      'classGroupId',
      'period',
      'mode',
      'lens',
      'comparisonPeriod',
      'rows',
      'columns',
      'order',
    ]) ||
    request.contractVersion !== CLASS_PERFORMANCE_CONTRACT_VERSION_V1 ||
    !isNonEmptyString(request.academicYearId) ||
    !isNonEmptyString(request.classGroupId) ||
    !isPerformancePeriodV1(request.period) ||
    !PERFORMANCE_MODES_V1.includes(request.mode as PerformanceModeV1) ||
    !PERFORMANCE_LENSES_V1.includes(request.lens as PerformanceLensV1) ||
    (request.comparisonPeriod !== null && !isPerformancePeriodV1(request.comparisonPeriod)) ||
    !isPageRequestV1(request.rows) ||
    !isPageRequestV1(request.columns) ||
    !isOrderRequestV1(request.order)
  ) {
    return 'invalid-request';
  }
  return 'ready';
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSourcePosition(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

export function comparePerformanceStudentRowsV1(
  left: PerformanceStudentRowV1,
  right: PerformanceStudentRowV1,
): number {
  return (
    compareSourcePosition(left.sourcePosition, right.sourcePosition) ||
    compareCodeUnits(left.displayName, right.displayName) ||
    compareCodeUnits(left.studentId, right.studentId)
  );
}

export function comparePerformanceComponentColumnsV1(
  left: PerformanceComponentColumnV1,
  right: PerformanceComponentColumnV1,
): number {
  return (
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.displayName, right.displayName) ||
    compareCodeUnits(left.teachingAssignmentId, right.teachingAssignmentId)
  );
}

export function isPerformanceStudentRowOrderV1(items: readonly PerformanceStudentRowV1[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) return false;
    if (comparePerformanceStudentRowsV1(previous, current) > 0) return false;
  }
  return true;
}

export function isPerformanceComponentColumnOrderV1(
  items: readonly PerformanceComponentColumnV1[],
): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) return false;
    if (comparePerformanceComponentColumnsV1(previous, current) > 0) return false;
  }
  return true;
}

function isSourcePositionV1(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value > 0);
}

export function isPerformanceRowsPageValidV1(page: PerformanceRowsPageV1): boolean {
  return (
    isPerformancePageLimitV1(page.limit) &&
    page.items.length <= page.limit &&
    page.items.every(
      (row) =>
        isSourcePositionV1(row.sourcePosition) &&
        row.studentId.trim().length > 0 &&
        row.displayName.trim().length > 0 &&
        row.detailRef.trim().length > 0,
    ) &&
    isPerformanceStudentRowOrderV1(page.items) &&
    (page.nextCursor === null || page.nextCursor.trim().length > 0)
  );
}

export function isPerformanceColumnsPageValidV1(page: PerformanceColumnsPageV1): boolean {
  return (
    isPerformancePageLimitV1(page.limit) &&
    page.items.length <= page.limit &&
    page.items.every(
      (column) =>
        column.teachingAssignmentId.trim().length > 0 &&
        column.subjectId.trim().length > 0 &&
        column.code.trim().length > 0 &&
        column.displayName.trim().length > 0,
    ) &&
    isPerformanceComponentColumnOrderV1(page.items) &&
    (page.nextCursor === null || page.nextCursor.trim().length > 0)
  );
}

export function isClassPerformanceReadModelValidV1(model: ClassPerformanceReadModelV1): boolean {
  if (
    model.contractVersion !== CLASS_PERFORMANCE_CONTRACT_VERSION_V1 ||
    model.academicYearId.trim().length === 0 ||
    model.classGroupId.trim().length === 0 ||
    !isPerformancePeriodV1(model.period) ||
    !PERFORMANCE_MODES_V1.includes(model.mode) ||
    !PERFORMANCE_LENSES_V1.includes(model.lens) ||
    (model.comparisonPeriod !== null && !isPerformancePeriodV1(model.comparisonPeriod)) ||
    model.authorityMode !== PERFORMANCE_AUTHORITY_MODE_V1 ||
    model.order.rows !== PERFORMANCE_ROW_ORDER_V1 ||
    model.order.columns !== PERFORMANCE_COLUMN_ORDER_V1 ||
    !isPerformanceRowsPageValidV1(model.rows) ||
    !isPerformanceColumnsPageValidV1(model.columns)
  ) {
    return false;
  }

  const columnIds = model.columns.items.map((column) => column.teachingAssignmentId);
  return model.rows.items.every(
    (row) =>
      row.cells.length === columnIds.length &&
      row.cells.every(
        (cell, index) =>
          cell.lens === model.lens &&
          cell.authorityMode === PERFORMANCE_AUTHORITY_MODE_V1 &&
          cell.detailRef.trim().length > 0 &&
          cell.teachingAssignmentId === columnIds[index],
      ),
  );
}
