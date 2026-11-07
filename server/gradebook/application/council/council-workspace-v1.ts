import {
  COUNCIL_WORKSPACE_AUTHORIZATION_POLICY_V1,
  COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
  inspectCouncilDecisionRequestV1,
  inspectCouncilQueueRequestV1,
  inspectCouncilStudentRequestV1,
  type CouncilActorReferenceV1,
  type CouncilDecisionRequestV1,
  type CouncilDecisionResponseV1,
  type CouncilQueueRequestV1,
  type CouncilQueueResponseV1,
  type CouncilStudentRequestV1,
  type CouncilStudentResponseV1,
} from '../../../../shared/gradebook-contracts/council/council-workspace-contract-v1';
import type {
  CouncilDecisionStoreKeyV1,
  CouncilDecisionStoreV1,
} from './council-decision-store-v1';
import {
  CouncilWorkspaceSourceErrorV1,
  type CouncilWorkspaceSourceV1,
  type CouncilWorkspaceSourceStudentV1,
} from './council-workspace-source-v1';

export interface CouncilWorkspaceServerContextV1 {
  /** Server authorization result; requests never carry roles or capabilities. */
  isAuthorized(): boolean;
  /** Effective actor and instant are resolved only after an allowed explicit decision request. */
  decisionIdentity(): {
    readonly actorReference: CouncilActorReferenceV1;
    readonly decidedAt: string;
  };
}

interface CouncilWorkspaceDependenciesV1 {
  readonly source: CouncilWorkspaceSourceV1;
  readonly decisions: CouncilDecisionStoreV1;
  readonly server: CouncilWorkspaceServerContextV1;
}

export interface CouncilWorkspaceV1 {
  readonly authorizationPolicy: typeof COUNCIL_WORKSPACE_AUTHORIZATION_POLICY_V1;
  queue(request: CouncilQueueRequestV1): Promise<CouncilQueueResponseV1>;
  student(request: CouncilStudentRequestV1): Promise<CouncilStudentResponseV1>;
  decide(request: CouncilDecisionRequestV1): Promise<CouncilDecisionResponseV1>;
}

function queueNonDisclosure(
  outcome: Exclude<CouncilQueueResponseV1, { readonly outcome: 'items' }>['outcome'],
): CouncilQueueResponseV1 {
  return {
    contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
    outcome,
    items: [],
    nextCursor: null,
  };
}

function detailNonDisclosure(
  outcome: Exclude<CouncilStudentResponseV1, { readonly outcome: 'detail' }>['outcome'],
): CouncilStudentResponseV1 {
  return {
    contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
    outcome,
    detail: null,
  };
}

function decisionNonDisclosure(
  outcome: Exclude<
    CouncilDecisionResponseV1,
    { readonly outcome: 'applied' | 'version-conflict' }
  >['outcome'],
): CouncilDecisionResponseV1 {
  return {
    contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
    outcome,
    currentVersion: null,
  };
}

function storeKey(
  academicYearId: CouncilStudentRequestV1['academicYearId'],
  classReference: CouncilStudentRequestV1['classReference'],
  studentReference: CouncilStudentRequestV1['studentReference'],
): CouncilDecisionStoreKeyV1 {
  return { academicYearId, classReference, studentReference };
}

function sameKey(left: CouncilDecisionStoreKeyV1, right: CouncilDecisionStoreKeyV1): boolean {
  return (
    left.academicYearId === right.academicYearId &&
    left.classReference === right.classReference &&
    left.studentReference === right.studentReference
  );
}

function sourceStudentMatchesRequest(
  student: CouncilWorkspaceSourceStudentV1,
  request: CouncilStudentRequestV1,
): boolean {
  return (
    student.academicYearId === request.academicYearId &&
    student.classReference === request.classReference &&
    student.studentReference === request.studentReference
  );
}

function sourceFailureOutcome(error: unknown): 'invalid-cursor' | 'insufficient-data' | 'unavailable' {
  if (error instanceof CouncilWorkspaceSourceErrorV1) return error.code;
  return 'unavailable';
}

export function createCouncilWorkspaceV1(
  dependencies: CouncilWorkspaceDependenciesV1,
): CouncilWorkspaceV1 {
  return {
    authorizationPolicy: COUNCIL_WORKSPACE_AUTHORIZATION_POLICY_V1,

    async queue(request) {
      const readiness = inspectCouncilQueueRequestV1(request);
      if (readiness !== 'ready') return queueNonDisclosure(readiness);
      if (!dependencies.server.isAuthorized()) return queueNonDisclosure('not-authorized');

      try {
        const page = await dependencies.source.listQueue(request);
        if (page.items.length === 0) return queueNonDisclosure('no-results');

        const keys = page.items.map((item) =>
          storeKey(request.academicYearId, request.classReference, item.studentReference),
        );
        const versions = await dependencies.decisions.getVersions(keys);
        if (versions.length !== keys.length) return queueNonDisclosure('insufficient-data');

        const items = page.items.map((item, index) => {
          const key = keys[index];
          const version = versions[index];
          if (key === undefined || version === undefined || !sameKey(key, version.key)) {
            throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
          }
          return {
            studentReference: item.studentReference,
            studentLabel: item.studentLabel,
            calculated: item.calculated,
            currentDecisionVersion: version.version,
          };
        });

        return {
          contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'items',
          academicYearId: request.academicYearId,
          classReference: request.classReference,
          items,
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        return queueNonDisclosure(sourceFailureOutcome(error));
      }
    },

    async student(request) {
      if (inspectCouncilStudentRequestV1(request) !== 'ready') {
        return detailNonDisclosure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return detailNonDisclosure('not-authorized');

      try {
        const student = await dependencies.source.getStudent(request);
        if (student === null) return detailNonDisclosure('not-found');
        if (!sourceStudentMatchesRequest(student, request)) {
          return detailNonDisclosure('insufficient-data');
        }

        const key = storeKey(request.academicYearId, request.classReference, request.studentReference);
        const history = await dependencies.decisions.getHistory(key);
        const currentDecision = history.at(-1) ?? null;
        return {
          contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'detail',
          academicYearId: request.academicYearId,
          detail: {
            studentReference: student.studentReference,
            studentLabel: student.studentLabel,
            classReference: student.classReference,
            classLabel: student.classLabel,
            calculated: student.calculated,
            annualView: student.annualView,
            currentDecision,
            history,
            version: currentDecision?.version ?? 0,
          },
        };
      } catch (error) {
        if (
          error instanceof CouncilWorkspaceSourceErrorV1 &&
          error.code === 'insufficient-data'
        ) {
          return detailNonDisclosure('insufficient-data');
        }
        return detailNonDisclosure('unavailable');
      }
    },

    async decide(request) {
      if (inspectCouncilDecisionRequestV1(request) !== 'ready') {
        return decisionNonDisclosure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return decisionNonDisclosure('not-authorized');

      try {
        const studentRequest: CouncilStudentRequestV1 = {
          operation: 'student',
          contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
          academicYearId: request.academicYearId,
          classReference: request.classReference,
          studentReference: request.studentReference,
        };
        const student = await dependencies.source.getStudent(studentRequest);
        if (student === null) return decisionNonDisclosure('not-found');
        if (!sourceStudentMatchesRequest(student, studentRequest)) {
          return decisionNonDisclosure('insufficient-data');
        }
        if (student.calculated.queueState !== 'eligible-for-council') {
          return decisionNonDisclosure('decision-unavailable');
        }

        const identity = dependencies.server.decisionIdentity();
        if (
          identity.actorReference.trim().length === 0 ||
          identity.decidedAt.trim().length === 0 ||
          Number.isNaN(Date.parse(identity.decidedAt))
        ) {
          return decisionNonDisclosure('unavailable');
        }

        const result = await dependencies.decisions.append({
          academicYearId: request.academicYearId,
          classReference: request.classReference,
          studentReference: request.studentReference,
          expectedVersion: request.expectedVersion,
          decision: request.decision,
          justification: request.justification.trim(),
          actorReference: identity.actorReference,
          decidedAt: identity.decidedAt,
        });

        if (result.status === 'version-conflict') {
          return {
            contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
            outcome: 'version-conflict',
            currentVersion: result.currentVersion,
          };
        }
        return {
          contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'applied',
          studentReference: request.studentReference,
          version: result.record.version,
          record: result.record,
        };
      } catch (error) {
        if (
          error instanceof CouncilWorkspaceSourceErrorV1 &&
          error.code === 'insufficient-data'
        ) {
          return decisionNonDisclosure('insufficient-data');
        }
        return decisionNonDisclosure('unavailable');
      }
    },
  };
}
