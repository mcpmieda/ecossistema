import type {
  AcademicYearId,
  ClassGroupId,
  EnrollmentId,
  EntityIdV1,
  StudentId,
  StudentStatusEventId,
  SubjectId,
  TeacherId,
  TeachingAssignmentId,
} from '../entities';
import type {
  AnnualResultId,
  AssessmentComponentId,
  ComparedGradeValueV1,
  FinalRecoveryId,
  GradeEntryId,
  TermResultId,
} from '../results/results-contract-v1';
import type { CompatibleSourceCellEvidenceV5 as SourceCellEvidenceV1 } from '../source/source-values-contract-v5';
import type { ImportBatchId, SourceFileManifestId } from '../imports/import-ids-v1';

export type ReconciliationResultId = EntityIdV1<'ReconciliationResultV1'>;
export type AuditOccurrenceId = EntityIdV1<'AuditOccurrenceV1'>;

export const AUDIT_SEVERITIES_V1 = [
  'information',
  'warning',
  'blocking-error',
  'critical-error',
] as const;
export type AuditSeverityV1 = (typeof AUDIT_SEVERITIES_V1)[number];

export type AuditEntityReferenceV1 =
  | { readonly kind: 'academic-year'; readonly id: AcademicYearId }
  | { readonly kind: 'teacher'; readonly id: TeacherId }
  | { readonly kind: 'class-group'; readonly id: ClassGroupId }
  | { readonly kind: 'subject'; readonly id: SubjectId }
  | { readonly kind: 'teaching-assignment'; readonly id: TeachingAssignmentId }
  | { readonly kind: 'student'; readonly id: StudentId }
  | { readonly kind: 'enrollment'; readonly id: EnrollmentId }
  | { readonly kind: 'student-status-event'; readonly id: StudentStatusEventId }
  | { readonly kind: 'assessment-component'; readonly id: AssessmentComponentId }
  | { readonly kind: 'grade-entry'; readonly id: GradeEntryId }
  | { readonly kind: 'term-result'; readonly id: TermResultId }
  | { readonly kind: 'final-recovery'; readonly id: FinalRecoveryId }
  | { readonly kind: 'annual-result'; readonly id: AnnualResultId };

export type ReconciliationTargetV1 =
  | { readonly kind: 'grade-entry'; readonly id: GradeEntryId }
  | { readonly kind: 'term-result'; readonly id: TermResultId }
  | { readonly kind: 'final-recovery'; readonly id: FinalRecoveryId }
  | { readonly kind: 'annual-result'; readonly id: AnnualResultId };

export const RECONCILIATION_STATUSES_V1 = [
  'match',
  'expected-difference',
  'mismatch',
  'not-comparable',
] as const;
export type ReconciliationStatusV1 = (typeof RECONCILIATION_STATUSES_V1)[number];

interface ReconciliationResultBaseV1 {
  readonly id: ReconciliationResultId;
  readonly target: ReconciliationTargetV1;
  readonly value: ComparedGradeValueV1;
  readonly ruleVersion: string;
}

export type ReconciliationResultV1 =
  | (ReconciliationResultBaseV1 & {
      readonly status: 'match' | 'expected-difference' | 'mismatch';
      readonly difference: number;
      readonly tolerance: number;
      readonly explanation?: string;
    })
  | (ReconciliationResultBaseV1 & {
      readonly status: 'not-comparable';
      readonly difference: null;
      readonly tolerance: number | null;
      readonly explanation: string;
    });

type AuditSourceReferenceV1 =
  | {
      readonly kind: 'file';
      readonly sourceFileManifestId: SourceFileManifestId;
    }
  | {
      readonly kind: 'sheet';
      readonly sourceFileManifestId: SourceFileManifestId;
      readonly sheetName: string;
    }
  | {
      readonly kind: 'cell';
      readonly sourceFileManifestId: SourceFileManifestId;
      readonly evidence: SourceCellEvidenceV1;
    };

export const AUDIT_OCCURRENCE_STATES_V1 = [
  'open',
  'acknowledged',
  'resolved',
  'dismissed-with-reason',
] as const;
export type AuditOccurrenceStateV1 = (typeof AUDIT_OCCURRENCE_STATES_V1)[number];

export interface AuditAcknowledgedTransitionV1 {
  readonly previousState: 'open';
  readonly nextState: 'acknowledged';
  readonly actorId: string;
  readonly occurredAt: string;
  readonly note?: string;
}

export interface AuditResolvedTransitionV1 {
  readonly previousState: 'open' | 'acknowledged';
  readonly nextState: 'resolved';
  readonly actorId: string;
  readonly occurredAt: string;
  readonly justification: string;
}

export interface AuditDismissedTransitionV1 {
  readonly previousState: 'open' | 'acknowledged';
  readonly nextState: 'dismissed-with-reason';
  readonly actorId: string;
  readonly occurredAt: string;
  readonly justification: string;
}

export type AuditOccurrenceStateTransitionV1 =
  AuditAcknowledgedTransitionV1 | AuditResolvedTransitionV1 | AuditDismissedTransitionV1;

interface AuditOccurrenceBaseV1 {
  readonly id: AuditOccurrenceId;
  readonly importBatchId?: ImportBatchId;
  readonly severity: AuditSeverityV1;
  readonly category: string;
  readonly entity?: AuditEntityReferenceV1;
  readonly source?: AuditSourceReferenceV1;
  readonly message: string;
  readonly recommendedAction?: string;
  readonly createdAt: string;
}

export type AuditOccurrenceV1 =
  | (AuditOccurrenceBaseV1 & {
      readonly state: 'open';
      readonly stateHistory: readonly AuditOccurrenceStateTransitionV1[];
    })
  | (AuditOccurrenceBaseV1 & {
      readonly state: 'acknowledged';
      readonly stateHistory: readonly [
        ...AuditOccurrenceStateTransitionV1[],
        AuditAcknowledgedTransitionV1,
      ];
    })
  | (AuditOccurrenceBaseV1 & {
      readonly state: 'resolved';
      readonly stateHistory: readonly [
        ...AuditOccurrenceStateTransitionV1[],
        AuditResolvedTransitionV1,
      ];
    })
  | (AuditOccurrenceBaseV1 & {
      readonly state: 'dismissed-with-reason';
      readonly stateHistory: readonly [
        ...AuditOccurrenceStateTransitionV1[],
        AuditDismissedTransitionV1,
      ];
    });

export const AUDIT_CONTRACT_V1 = {
  version: 1,
  severities: AUDIT_SEVERITIES_V1,
  reconciliationStatuses: RECONCILIATION_STATUSES_V1,
  occurrenceStates: AUDIT_OCCURRENCE_STATES_V1,
} as const;
