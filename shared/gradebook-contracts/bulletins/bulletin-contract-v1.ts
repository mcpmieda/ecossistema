import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  StudentId,
  SubjectId,
  TeachingAssignmentId,
} from '../entities';
import {
  ACADEMIC_TERMS_V1,
  type AcademicTermV1,
  type AnnualFinalDecisionV1,
  type AnnualResultId,
  type ApplicabilityV1,
  type AssessmentComponentId,
  type AssessmentComponentTypeV1,
  type AuthorityModeV1,
  type ComparedAcademicStateV1,
  type ComparedApplicabilityV1,
  type ComparedGradeValueV1,
  type GradeEntryId,
  type ResultCoverageV1,
  type TermResultId,
} from '../results/results-contract-v1';
import type { AssessmentComponentTypeV2 } from '../results/results-contract-v2';

export const BULLETIN_CONTRACT_VERSION_V1 = 1 as const;
export const BULLETIN_MODEL_VERSION_V1 = 1 as const;
export type BulletinAuthorityModeV1 = Extract<AuthorityModeV1, 'imported-source'>;
export const BULLETIN_AUTHORITY_MODE_V1 =
  'imported-source' as const satisfies BulletinAuthorityModeV1;

export const BULLETIN_MODEL_KINDS_V1 = ['synthetic', 'composition', 'detailed'] as const;
export type BulletinModelKindV1 = (typeof BULLETIN_MODEL_KINDS_V1)[number];

const BULLETIN_EMISSION_STATUSES_V1 = ['ready', 'blocked', 'insufficient-data'] as const;

const BULLETIN_PRESENTATION_DATE_STYLES_V1 = ['short', 'long'] as const;
type BulletinPresentationDateStyleV1 = (typeof BULLETIN_PRESENTATION_DATE_STYLES_V1)[number];

export interface BulletinPresentationOptionsV1 {
  readonly locale: string;
  readonly dateStyle: BulletinPresentationDateStyleV1;
}

export type BulletinPeriodV1 =
  | {
      readonly kind: 'term';
      readonly term: AcademicTermV1;
    }
  | {
      readonly kind: 'annual';
    };

export type BulletinEmissionTargetV1 =
  | {
      readonly kind: 'student';
      readonly classGroupId: ClassGroupId;
      readonly studentId: StudentId;
      readonly enrollmentId: EnrollmentId;
    }
  | {
      readonly kind: 'class-group';
      readonly classGroupId: ClassGroupId;
    };

/**
 * Provider-independent request. Authentication, authorization and issuer identity are deliberately
 * absent and must be supplied/enforced by the server outside this client-shaped payload.
 */
export interface BulletinEmissionRequestV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly period: BulletinPeriodV1;
  readonly target: BulletinEmissionTargetV1;
  readonly model: BulletinModelKindV1;
  readonly presentation: BulletinPresentationOptionsV1;
}

/** Safe projection of the official compared value: source evidence never reaches a bulletin. */
export interface BulletinComparedGradeValueV1 {
  readonly imported: ComparedGradeValueV1['imported']['value'];
  readonly calculated: ComparedGradeValueV1['calculated']['value'];
}

/** Safe projection of official applicability with source evidence deliberately omitted. */
export interface BulletinComparedApplicabilityV1 {
  readonly imported: ComparedApplicabilityV1['imported']['value'];
  readonly calculated: ComparedApplicabilityV1['calculated'];
}

export interface BulletinStudentIdentityV1 {
  readonly id: StudentId;
  readonly enrollmentId: EnrollmentId;
  readonly displayName: string;
}

interface BulletinClassGroupIdentityV1 {
  readonly id: ClassGroupId;
  readonly code: string;
}

export interface BulletinSubjectIdentityV1 {
  readonly id: SubjectId;
  readonly teachingAssignmentId: TeachingAssignmentId;
  readonly displayName: string;
}

export interface BulletinTermSummaryV1 {
  readonly kind: 'term';
  readonly termResultId: TermResultId;
  readonly term: AcademicTermV1;
  readonly officialGrade: BulletinComparedGradeValueV1;
  readonly percentage: BulletinComparedGradeValueV1;
  readonly authorityMode: BulletinAuthorityModeV1;
  readonly coverage: ResultCoverageV1;
}

export interface BulletinAnnualResultV1 {
  readonly kind: 'annual';
  readonly annualResultId: AnnualResultId;
  readonly originalTotal: BulletinComparedGradeValueV1;
  readonly postRecoveryTotal: BulletinComparedGradeValueV1;
  readonly academicState: ComparedAcademicStateV1;
  readonly finalDecision: AnnualFinalDecisionV1;
  readonly authorityMode: BulletinAuthorityModeV1;
  readonly coverage: ResultCoverageV1;
}

export type BulletinSyntheticResultV1 = BulletinTermSummaryV1 | BulletinAnnualResultV1;

export interface BulletinTermCompositionV1 {
  readonly termResultId: TermResultId;
  readonly term: AcademicTermV1;
  readonly quantitative: {
    readonly original: BulletinComparedGradeValueV1;
    readonly parallelRecovery: BulletinComparedGradeValueV1;
    readonly parallelRecoveryApplicability: BulletinComparedApplicabilityV1;
    readonly considered: BulletinComparedGradeValueV1;
  };
  readonly qualitativeOperational: BulletinComparedGradeValueV1;
  readonly officialGrade: BulletinComparedGradeValueV1;
  readonly percentage: BulletinComparedGradeValueV1;
  readonly authorityMode: BulletinAuthorityModeV1;
  readonly coverage: ResultCoverageV1;
}

export interface BulletinAssessmentEntryV1 {
  readonly assessmentComponentId: AssessmentComponentId;
  readonly gradeEntryId: GradeEntryId;
  readonly type: AssessmentComponentTypeV1 | AssessmentComponentTypeV2;
  readonly name: string;
  readonly applicability: ApplicabilityV1;
  readonly value: BulletinComparedGradeValueV1;
  readonly authorityMode: BulletinAuthorityModeV1;
}

export interface BulletinDetailedTermV1 extends BulletinTermCompositionV1 {
  readonly assessments: readonly BulletinAssessmentEntryV1[];
}

export interface BulletinSyntheticSubjectV1 {
  readonly subject: BulletinSubjectIdentityV1;
  readonly result: BulletinSyntheticResultV1;
}

export interface BulletinCompositionSubjectV1 {
  readonly subject: BulletinSubjectIdentityV1;
  readonly terms: readonly BulletinTermCompositionV1[];
  readonly annualResult: BulletinAnnualResultV1 | null;
}

export interface BulletinDetailedSubjectV1 {
  readonly subject: BulletinSubjectIdentityV1;
  readonly terms: readonly BulletinDetailedTermV1[];
  readonly annualResult: BulletinAnnualResultV1 | null;
}

interface BulletinModelBaseV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly modelVersion: typeof BULLETIN_MODEL_VERSION_V1;
  readonly academicYearId: AcademicYearId;
  readonly period: BulletinPeriodV1;
  readonly student: BulletinStudentIdentityV1;
  readonly classGroup: BulletinClassGroupIdentityV1;
  readonly authorityMode: BulletinAuthorityModeV1;
}

export type BulletinModelV1 =
  | (BulletinModelBaseV1 & {
      readonly modelKind: 'synthetic';
      readonly subjects: readonly BulletinSyntheticSubjectV1[];
    })
  | (BulletinModelBaseV1 & {
      readonly modelKind: 'composition';
      readonly subjects: readonly BulletinCompositionSubjectV1[];
    })
  | (BulletinModelBaseV1 & {
      readonly modelKind: 'detailed';
      readonly subjects: readonly BulletinDetailedSubjectV1[];
    });

declare const bulletinSnapshotIdBrand: unique symbol;
declare const bulletinDataVersionBrand: unique symbol;
declare const bulletinIssuerIdBrand: unique symbol;

export type BulletinSnapshotIdV1 = string & {
  readonly [bulletinSnapshotIdBrand]: 'BulletinSnapshotIdV1';
};

/** Opaque application-owned version of the academic data used by one emission. */
export type BulletinDataVersionV1 = string & {
  readonly [bulletinDataVersionBrand]: 'BulletinDataVersionV1';
};

/** Opaque identity supplied by the authorized server; never accepted from an emission request. */
export type BulletinIssuerIdV1 = string & {
  readonly [bulletinIssuerIdBrand]: 'BulletinIssuerIdV1';
};

export interface BulletinSnapshotV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly snapshotId: BulletinSnapshotIdV1;
  readonly snapshotVersion: number;
  readonly modelVersion: typeof BULLETIN_MODEL_VERSION_V1;
  readonly dataVersion: BulletinDataVersionV1;
  readonly emittedAt: string;
  readonly issuerId: BulletinIssuerIdV1;
  readonly presentation: BulletinPresentationOptionsV1;
  readonly model: BulletinModelV1;
}

/** Preview and PDF intentionally share this exact canonical input shape. */
export interface BulletinArtifactInputV1 {
  readonly snapshot: BulletinSnapshotV1;
}

export type BulletinPreviewInputV1 = BulletinArtifactInputV1;
export type BulletinPdfInputV1 = BulletinArtifactInputV1;

export type BulletinEmissionReasonsV1 = readonly [string, ...string[]];

export interface BulletinEmissionReadyV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly status: 'ready';
  readonly snapshot: BulletinSnapshotV1;
}

export interface BulletinEmissionBlockedV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly status: 'blocked';
  readonly reasons: BulletinEmissionReasonsV1;
}

export interface BulletinEmissionInsufficientDataV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly status: 'insufficient-data';
  readonly coverage: ResultCoverageV1;
  readonly reasons: BulletinEmissionReasonsV1;
}

export type BulletinEmissionResultV1 =
  BulletinEmissionReadyV1 | BulletinEmissionBlockedV1 | BulletinEmissionInsufficientDataV1;

export interface BulletinReprintRequestV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly snapshotId: BulletinSnapshotIdV1;
  readonly snapshotVersion: number;
}

export type BulletinReprintResultV1 =
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly status: 'ready';
      readonly source: 'historical-snapshot';
      readonly snapshot: BulletinSnapshotV1;
    }
  | {
      readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
      readonly status: 'blocked';
      readonly source: 'historical-snapshot';
      readonly reasons: BulletinEmissionReasonsV1;
    };

export interface BulletinBatchEmissionRequestV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly items: readonly [BulletinEmissionRequestV1, ...BulletinEmissionRequestV1[]];
}

export interface BulletinBatchEmissionResultV1 {
  readonly contractVersion: typeof BULLETIN_CONTRACT_VERSION_V1;
  readonly ready: readonly {
    readonly requestIndex: number;
    readonly emission: BulletinEmissionReadyV1;
  }[];
  readonly blocked: readonly {
    readonly requestIndex: number;
    readonly emission: BulletinEmissionBlockedV1 | BulletinEmissionInsufficientDataV1;
  }[];
}

const BULLETIN_FORBIDDEN_CLIENT_REQUEST_FIELDS_V1 = [
  'formula',
  'formulas',
  'weight',
  'weights',
  'cutoff',
  'cutoffs',
  'threshold',
  'thresholds',
  'rule',
  'rules',
  'academicRule',
  'academicRules',
  'token',
  'accessToken',
  'authorization',
  'authorized',
  'role',
  'roles',
  'capability',
  'capabilities',
  'issuerId',
  'actorId',
  'emitterId',
  'emittedBy',
  'signature',
  'retention',
  'storage',
] as const;

const BULLETIN_FORBIDDEN_ARTIFACT_FIELDS_V1 = [
  'formula',
  'formulas',
  'weight',
  'weights',
  'cutoff',
  'cutoffs',
  'threshold',
  'thresholds',
  'rule',
  'rules',
  'ruleVersion',
  'evidence',
  'sourceEvidence',
  'rawValue',
  'token',
  'accessToken',
  'authorization',
  'authorized',
  'role',
  'roles',
  'capability',
  'capabilities',
  'html',
  'css',
  'route',
  'renderer',
  'binary',
] as const;

export const BULLETIN_CONTRACT_V1 = {
  version: BULLETIN_CONTRACT_VERSION_V1,
  modelVersion: BULLETIN_MODEL_VERSION_V1,
  modelKinds: BULLETIN_MODEL_KINDS_V1,
  emissionStatuses: BULLETIN_EMISSION_STATUSES_V1,
  authorityMode: BULLETIN_AUTHORITY_MODE_V1,
  presentation: {
    dateStyles: BULLETIN_PRESENTATION_DATE_STYLES_V1,
    academicRules: 'forbidden',
  },
  snapshot: {
    immutable: true,
    dataVersion: 'opaque',
    issuerIdentity: 'server-supplied-opaque',
    reprintSource: 'historical-snapshot',
  },
  artifacts: {
    previewAndPdfInput: 'same-canonical-snapshot',
    renderer: 'outside-contract',
    html: 'outside-contract',
    css: 'outside-contract',
  },
  academicValues: {
    source: 'official-academic-result-contracts',
    importedAndCalculatedSides: 'preserved',
    sourceEvidence: 'omitted',
    formulas: 'forbidden',
    weights: 'forbidden',
    cutoffs: 'forbidden',
    rules: 'forbidden',
  },
  authorization: {
    enforcement: 'server',
    clientClaims: 'forbidden',
    clientIssuerIdentity: 'forbidden',
  },
} as const;

type BulletinRequestReadinessV1 = 'ready' | 'invalid-request' | 'forbidden-client-payload';

function canonicalFieldName(field: string): string {
  return field.replace(/[-_]/gu, '').toLowerCase();
}

function normalizedFieldSet(fields: readonly string[]): ReadonlySet<string> {
  return new Set(fields.map(canonicalFieldName));
}

const FORBIDDEN_CLIENT_REQUEST_FIELD_SET_V1 = normalizedFieldSet(
  BULLETIN_FORBIDDEN_CLIENT_REQUEST_FIELDS_V1,
);
const FORBIDDEN_ARTIFACT_FIELD_SET_V1 = normalizedFieldSet(BULLETIN_FORBIDDEN_ARTIFACT_FIELDS_V1);

function containsFieldFromSet(
  input: unknown,
  forbiddenFields: ReadonlySet<string>,
  visited: WeakSet<object>,
): boolean {
  if (input === null || typeof input !== 'object') return false;
  if (visited.has(input)) return false;
  visited.add(input);

  if (Array.isArray(input)) {
    return input.some((item) => containsFieldFromSet(item, forbiddenFields, visited));
  }

  for (const [field, value] of Object.entries(input)) {
    if (forbiddenFields.has(canonicalFieldName(field))) return true;
    if (containsFieldFromSet(value, forbiddenFields, visited)) return true;
  }
  return false;
}

export function hasForbiddenBulletinClientPayloadV1(input: unknown): boolean {
  return containsFieldFromSet(input, FORBIDDEN_CLIENT_REQUEST_FIELD_SET_V1, new WeakSet());
}

export function isBulletinArtifactPayloadSafeV1(input: unknown): boolean {
  return !containsFieldFromSet(input, FORBIDDEN_ARTIFACT_FIELD_SET_V1, new WeakSet());
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function hasExactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(input);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

function isAcademicTermV1(input: unknown): input is AcademicTermV1 {
  return ACADEMIC_TERMS_V1.includes(input as AcademicTermV1);
}

function isBulletinModelKindV1(input: unknown): input is BulletinModelKindV1 {
  return BULLETIN_MODEL_KINDS_V1.includes(input as BulletinModelKindV1);
}

function isBulletinPresentationOptionsV1(input: unknown): input is BulletinPresentationOptionsV1 {
  if (!isRecord(input) || !hasExactKeys(input, ['locale', 'dateStyle'])) return false;
  return (
    isNonEmptyString(input.locale) &&
    BULLETIN_PRESENTATION_DATE_STYLES_V1.includes(
      input.dateStyle as BulletinPresentationDateStyleV1,
    )
  );
}

function isBulletinPeriodV1(input: unknown): input is BulletinPeriodV1 {
  if (!isRecord(input) || typeof input.kind !== 'string') return false;
  if (input.kind === 'annual') return hasExactKeys(input, ['kind']);
  if (input.kind !== 'term' || !hasExactKeys(input, ['kind', 'term'])) return false;
  return isAcademicTermV1(input.term);
}

function isBulletinEmissionTargetV1(input: unknown): input is BulletinEmissionTargetV1 {
  if (!isRecord(input) || typeof input.kind !== 'string') return false;
  if (input.kind === 'class-group') {
    return hasExactKeys(input, ['kind', 'classGroupId']) && isNonEmptyString(input.classGroupId);
  }
  if (input.kind !== 'student') return false;
  return (
    hasExactKeys(input, ['kind', 'classGroupId', 'studentId', 'enrollmentId']) &&
    isNonEmptyString(input.classGroupId) &&
    isNonEmptyString(input.studentId) &&
    isNonEmptyString(input.enrollmentId)
  );
}

export function inspectBulletinEmissionRequestV1(input: unknown): BulletinRequestReadinessV1 {
  if (hasForbiddenBulletinClientPayloadV1(input)) return 'forbidden-client-payload';
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'contractVersion',
      'academicYearId',
      'period',
      'target',
      'model',
      'presentation',
    ]) ||
    input.contractVersion !== BULLETIN_CONTRACT_VERSION_V1 ||
    !isNonEmptyString(input.academicYearId) ||
    !isBulletinPeriodV1(input.period) ||
    !isBulletinEmissionTargetV1(input.target) ||
    !isBulletinModelKindV1(input.model) ||
    !isBulletinPresentationOptionsV1(input.presentation)
  ) {
    return 'invalid-request';
  }
  return 'ready';
}

export function inspectBulletinBatchEmissionRequestV1(input: unknown): BulletinRequestReadinessV1 {
  if (hasForbiddenBulletinClientPayloadV1(input)) return 'forbidden-client-payload';
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['contractVersion', 'items']) ||
    input.contractVersion !== BULLETIN_CONTRACT_VERSION_V1 ||
    !Array.isArray(input.items) ||
    input.items.length === 0
  ) {
    return 'invalid-request';
  }

  for (const item of input.items) {
    const readiness = inspectBulletinEmissionRequestV1(item);
    if (readiness !== 'ready') return readiness;
  }
  return 'ready';
}

export function inspectBulletinReprintRequestV1(input: unknown): BulletinRequestReadinessV1 {
  if (hasForbiddenBulletinClientPayloadV1(input)) return 'forbidden-client-payload';
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['contractVersion', 'snapshotId', 'snapshotVersion']) ||
    input.contractVersion !== BULLETIN_CONTRACT_VERSION_V1 ||
    !isNonEmptyString(input.snapshotId) ||
    !isBulletinSnapshotVersionV1(input.snapshotVersion)
  ) {
    return 'invalid-request';
  }
  return 'ready';
}

function isBulletinSnapshotVersionV1(input: unknown): input is number {
  return typeof input === 'number' && Number.isInteger(input) && input > 0;
}

function hasCoherentBulletinAuthorityModesV1(model: BulletinModelV1): boolean {
  if (model.authorityMode !== BULLETIN_AUTHORITY_MODE_V1) return false;

  if (model.modelKind === 'synthetic') {
    return model.subjects.every(
      ({ result }) => result.authorityMode === BULLETIN_AUTHORITY_MODE_V1,
    );
  }

  if (model.modelKind === 'composition') {
    return model.subjects.every(
      ({ terms, annualResult }) =>
        terms.every(({ authorityMode }) => authorityMode === BULLETIN_AUTHORITY_MODE_V1) &&
        (annualResult === null || annualResult.authorityMode === BULLETIN_AUTHORITY_MODE_V1),
    );
  }

  return model.subjects.every(
    ({ terms, annualResult }) =>
      terms.every(
        ({ authorityMode, assessments }) =>
          authorityMode === BULLETIN_AUTHORITY_MODE_V1 &&
          assessments.every(
            (assessment) => assessment.authorityMode === BULLETIN_AUTHORITY_MODE_V1,
          ),
      ) &&
      (annualResult === null || annualResult.authorityMode === BULLETIN_AUTHORITY_MODE_V1),
  );
}

export function isBulletinSnapshotCoherentV1(snapshot: BulletinSnapshotV1): boolean {
  return (
    snapshot.contractVersion === BULLETIN_CONTRACT_VERSION_V1 &&
    isBulletinSnapshotVersionV1(snapshot.snapshotVersion) &&
    snapshot.modelVersion === BULLETIN_MODEL_VERSION_V1 &&
    snapshot.model.contractVersion === BULLETIN_CONTRACT_VERSION_V1 &&
    snapshot.model.modelVersion === snapshot.modelVersion &&
    hasCoherentBulletinAuthorityModesV1(snapshot.model) &&
    snapshot.model.academicYearId.trim().length > 0 &&
    snapshot.snapshotId.trim().length > 0 &&
    snapshot.dataVersion.trim().length > 0 &&
    snapshot.emittedAt.trim().length > 0 &&
    snapshot.issuerId.trim().length > 0 &&
    isBulletinPresentationOptionsV1(snapshot.presentation) &&
    isBulletinArtifactPayloadSafeV1({ snapshot })
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** Runtime helper for application code that materializes an immutable historical snapshot. */
export function freezeBulletinSnapshotV1(snapshot: BulletinSnapshotV1): BulletinSnapshotV1 {
  return deepFreeze(snapshot);
}
