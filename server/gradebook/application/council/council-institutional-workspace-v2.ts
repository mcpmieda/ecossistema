import {
  COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
  inspectCouncilInstitutionalRequestV2,
  type CouncilClosureBlockerV2,
  type CouncilClosureCloseRequestV2,
  type CouncilClosureCloseResponseV2,
  type CouncilClosureHistoryRequestV2,
  type CouncilClosureHistoryResponseV2,
  type CouncilClosureReviewItemV2,
  type CouncilClosureReviewRequestV2,
  type CouncilClosureReviewResponseV2,
  type CouncilInstitutionalFailureOutcomeV2,
  type CouncilInstitutionalFailureV2,
  type CouncilMeetingSummaryV2,
  type CouncilReviewReferenceV2,
  type CouncilTieBreakRequestV2,
  type CouncilTieBreakResponseV2,
  type CouncilVoteRequestV2,
  type CouncilVoteResponseV2,
} from '../../../../shared/gradebook-contracts/council/council-institutional-contract-v2';
import {
  COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
  COUNCIL_WORKSPACE_MAX_LIMIT_V1,
  type CouncilActorReferenceV1,
  type CouncilDecisionRequestV1,
  type CouncilDecisionResponseV1,
  type CouncilQueueRequestV1,
  type CouncilStudentRequestV1,
} from '../../../../shared/gradebook-contracts/council/council-workspace-contract-v1';
import type {
  CouncilDecisionStoreKeyV1,
  CouncilDecisionStoreV1,
} from './council-decision-store-v1';
import type {
  CouncilSessionStateV2,
  CouncilSessionStoreKeyV2,
  CouncilSessionStoreV2,
} from './council-session-store-v2';
import {
  CouncilWorkspaceSourceErrorV1,
  type CouncilWorkspaceSourceQueueItemV1,
  type CouncilWorkspaceSourceV1,
} from './council-workspace-source-v1';
import type {
  CouncilWorkspaceServerContextV1,
  CouncilWorkspaceV1,
} from './council-workspace-v1';

export interface CouncilInstitutionalServerContextV2 extends CouncilWorkspaceServerContextV1 {
  /** Actor/time for session-level actions. No role or director identity is inferred here. */
  institutionalIdentity(): {
    readonly actorReference: CouncilActorReferenceV1;
    readonly occurredAt: string;
  };
}

export interface CouncilInstitutionalWorkspaceDependenciesV2 {
  readonly source: CouncilWorkspaceSourceV1;
  readonly decisions: CouncilDecisionStoreV1;
  readonly workspace: CouncilWorkspaceV1;
  readonly sessions: CouncilSessionStoreV2;
  readonly server: CouncilInstitutionalServerContextV2;
}

export interface CouncilInstitutionalWorkspaceV2 {
  review(request: CouncilClosureReviewRequestV2): Promise<CouncilClosureReviewResponseV2>;
  vote(request: CouncilVoteRequestV2): Promise<CouncilVoteResponseV2>;
  resolveTie(request: CouncilTieBreakRequestV2): Promise<CouncilTieBreakResponseV2>;
  close(request: CouncilClosureCloseRequestV2): Promise<CouncilClosureCloseResponseV2>;
  history(request: CouncilClosureHistoryRequestV2): Promise<CouncilClosureHistoryResponseV2>;
  /** V1 decision semantics are reused and only guarded by the V2 open/closed session state. */
  decide(request: CouncilDecisionRequestV1): Promise<CouncilDecisionResponseV1>;
}

interface OpenReviewCandidateV2 {
  readonly reviewReference: CouncilReviewReferenceV2;
  readonly items: readonly CouncilClosureReviewItemV2[];
  readonly blockers: readonly CouncilClosureBlockerV2[];
}

function failure(
  outcome: CouncilInstitutionalFailureOutcomeV2,
  currentVersion: number | null = null,
  blockers?: readonly CouncilClosureBlockerV2[],
): CouncilInstitutionalFailureV2 {
  return {
    contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
    outcome,
    currentVersion,
    ...(blockers === undefined ? {} : { blockers }),
  };
}

function decisionUnavailable(): CouncilDecisionResponseV1 {
  return {
    contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
    outcome: 'decision-unavailable',
    currentVersion: null,
  };
}

function decisionNotAuthorized(): CouncilDecisionResponseV1 {
  return {
    contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
    outcome: 'not-authorized',
    currentVersion: null,
  };
}

function sessionKey(request: {
  readonly academicYearId: CouncilSessionStoreKeyV2['academicYearId'];
  readonly classReference: CouncilSessionStoreKeyV2['classReference'];
}): CouncilSessionStoreKeyV2 {
  return {
    academicYearId: request.academicYearId,
    classReference: request.classReference,
  };
}

function decisionKey(
  request: CouncilSessionStoreKeyV2,
  studentReference: CouncilDecisionStoreKeyV1['studentReference'],
): CouncilDecisionStoreKeyV1 {
  return {
    academicYearId: request.academicYearId,
    classReference: request.classReference,
    studentReference,
  };
}

function sameDecisionKey(left: CouncilDecisionStoreKeyV1, right: CouncilDecisionStoreKeyV1): boolean {
  return (
    left.academicYearId === right.academicYearId &&
    left.classReference === right.classReference &&
    left.studentReference === right.studentReference
  );
}

function sourceFailureOutcome(error: unknown): 'insufficient-data' | 'unavailable' {
  if (error instanceof CouncilWorkspaceSourceErrorV1 && error.code !== 'unavailable') {
    return 'insufficient-data';
  }
  return 'unavailable';
}

function identityValid(identity: {
  readonly actorReference: CouncilActorReferenceV1;
  readonly occurredAt: string;
}): boolean {
  return (
    identity.actorReference.trim().length > 0 &&
    identity.occurredAt.trim().length > 0 &&
    !Number.isNaN(Date.parse(identity.occurredAt))
  );
}

function meetingSummary(state: CouncilSessionStateV2): CouncilMeetingSummaryV2 {
  return {
    state: state.state,
    version: state.version,
    closedAt: state.closure?.closedAt ?? null,
    closedBy: state.closure?.closedBy ?? null,
  };
}

/** Small deterministic concurrency fingerprint; it is not an authorization or authenticity token. */
function reviewReference(value: unknown): CouncilReviewReferenceV2 {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index); // NOSONAR: UTF-16 code units on purpose, so the stored hash stays the same
    hash = Math.imul(hash, 0x01000193);
  }
  return `council-review:${(hash >>> 0).toString(16).padStart(8, '0')}` as CouncilReviewReferenceV2;
}

async function listCompleteQueue(
  source: CouncilWorkspaceSourceV1,
  key: CouncilSessionStoreKeyV2,
): Promise<readonly CouncilWorkspaceSourceQueueItemV1[]> {
  const items: CouncilWorkspaceSourceQueueItemV1[] = [];
  const students = new Set<string>();
  const cursors = new Set<string>();
  let cursor: CouncilQueueRequestV1['page']['cursor'] = null;

  while (true) {
    const request: CouncilQueueRequestV1 = {
      operation: 'queue',
      contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
      academicYearId: key.academicYearId,
      classReference: key.classReference,
      page: { limit: COUNCIL_WORKSPACE_MAX_LIMIT_V1, cursor },
    };
    const page = await source.listQueue(request);
    for (const item of page.items) {
      if (students.has(item.studentReference)) {
        throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
      }
      students.add(item.studentReference);
      items.push(item);
    }
    if (page.nextCursor === null) break;
    if (cursors.has(page.nextCursor)) {
      throw new CouncilWorkspaceSourceErrorV1('invalid-cursor');
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (items.length === 0) throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
  return items;
}

async function buildOpenReviewCandidate(
  dependencies: Pick<CouncilInstitutionalWorkspaceDependenciesV2, 'source' | 'decisions'>,
  key: CouncilSessionStoreKeyV2,
  state: CouncilSessionStateV2,
): Promise<OpenReviewCandidateV2> {
  const queue = await listCompleteQueue(dependencies.source, key);
  const keys = queue.map((item) => decisionKey(key, item.studentReference));
  const versions = await dependencies.decisions.getVersions(keys);
  if (versions.length !== keys.length) {
    throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
  }

  const currents = await Promise.all(
    versions.map(async (version, index) => {
      const expectedKey = keys[index];
      if (expectedKey === undefined || !sameDecisionKey(expectedKey, version.key)) {
        throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
      }
      if (version.version === 0) return null;
      const current = await dependencies.decisions.getCurrent(expectedKey);
      if (current === null || current.version !== version.version) {
        throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
      }
      return current;
    }),
  );
  const votes = new Map(state.votes.map((vote) => [vote.studentReference, vote]));

  const items = queue.map((item, index): CouncilClosureReviewItemV2 => {
    const version = versions[index];
    if (version === undefined) throw new CouncilWorkspaceSourceErrorV1('insufficient-data');
    const currentDecision = currents[index] ?? null;
    let consistency: 'decision-required' | 'ready' | 'decision-inconsistent';
    if (item.calculated.queueState === 'eligible-for-council') {
      if (currentDecision === null) {
        consistency = 'decision-required';
      } else {
        consistency = 'ready';
      }
    } else if (currentDecision === null) {
      consistency = 'ready';
    } else {
      consistency = 'decision-inconsistent';
    }
    return {
      studentReference: item.studentReference,
      studentLabel: item.studentLabel,
      calculated: item.calculated,
      currentDecisionVersion: version.version,
      currentDecision,
      vote: votes.get(item.studentReference) ?? null,
      consistency,
    };
  });
  const blockers = items
    .filter((item) => item.consistency !== 'ready')
    .map((item) => ({
      studentReference: item.studentReference,
      code: item.consistency as Exclude<typeof item.consistency, 'ready'>,
    }));

  return {
    reviewReference: reviewReference({
      academicYearId: key.academicYearId,
      classReference: key.classReference,
      sessionVersion: state.version,
      items,
    }),
    items,
    blockers,
  };
}

function sourceStudentMatches(
  student: Awaited<ReturnType<CouncilWorkspaceSourceV1['getStudent']>>,
  request: CouncilStudentRequestV1,
): boolean {
  return (
    student !== null &&
    student.academicYearId === request.academicYearId &&
    student.classReference === request.classReference &&
    student.studentReference === request.studentReference
  );
}

export function createCouncilInstitutionalWorkspaceV2(
  dependencies: CouncilInstitutionalWorkspaceDependenciesV2,
): CouncilInstitutionalWorkspaceV2 {
  return {
    async review(request) {
      if (
        inspectCouncilInstitutionalRequestV2(request) !== 'ready' ||
        request.operation !== 'closure-review'
      ) {
        return failure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return failure('not-authorized');
      const key = sessionKey(request);

      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const state = await dependencies.sessions.getState(key);
          if (state.state === 'closed' && state.closure !== null) {
            return {
              contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
              outcome: 'review' as const,
              academicYearId: request.academicYearId,
              classReference: request.classReference,
              meeting: meetingSummary(state),
              reviewReference: state.closure.reviewReference,
              items: state.closure.items,
              blockers: [],
              canClose: false,
            };
          }

          const candidate = await buildOpenReviewCandidate(dependencies, key, state);
          return {
            contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
            outcome: 'review' as const,
            academicYearId: request.academicYearId,
            classReference: request.classReference,
            meeting: meetingSummary(state),
            reviewReference: candidate.reviewReference,
            items: candidate.items,
            blockers: candidate.blockers,
            canClose: candidate.blockers.length === 0,
          };
        });
      } catch (error) {
        return failure(sourceFailureOutcome(error));
      }
    },

    async vote(request) {
      if (
        inspectCouncilInstitutionalRequestV2(request) !== 'ready' ||
        request.operation !== 'vote'
      ) {
        return failure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return failure('not-authorized');
      const key = sessionKey(request);

      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const state = await dependencies.sessions.getState(key);
          if (state.state === 'closed') return failure('meeting-closed', state.version);
          if (state.version !== request.expectedVersion) {
            return failure('version-conflict', state.version);
          }

          const studentRequest: CouncilStudentRequestV1 = {
            operation: 'student',
            contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
            academicYearId: request.academicYearId,
            classReference: request.classReference,
            studentReference: request.studentReference,
          };
          const student = await dependencies.source.getStudent(studentRequest);
          if (student === null) return failure('not-found', state.version);
          if (!sourceStudentMatches(student, studentRequest)) {
            return failure('insufficient-data', state.version);
          }

          const identity = dependencies.server.institutionalIdentity();
          if (!identityValid(identity)) return failure('unavailable', state.version);
          const result = await dependencies.sessions.recordVote({
            academicYearId: request.academicYearId,
            classReference: request.classReference,
            studentReference: request.studentReference,
            expectedVersion: request.expectedVersion,
            approvedVotes: request.approvedVotes,
            failedVotes: request.failedVotes,
            actorReference: identity.actorReference,
            recordedAt: identity.occurredAt,
          });
          if (result.status === 'closed') return failure('meeting-closed', result.currentVersion);
          if (result.status === 'version-conflict') {
            return failure('version-conflict', result.currentVersion);
          }
          return {
            contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
            outcome: 'vote-applied' as const,
            version: result.version,
            vote: result.vote,
          };
        });
      } catch (error) {
        return failure(sourceFailureOutcome(error));
      }
    },

    async resolveTie(request) {
      if (
        inspectCouncilInstitutionalRequestV2(request) !== 'ready' ||
        request.operation !== 'tie-break'
      ) {
        return failure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return failure('not-authorized');
      const key = sessionKey(request);

      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const state = await dependencies.sessions.getState(key);
          if (state.state === 'closed') return failure('meeting-closed', state.version);
          if (state.version !== request.expectedVersion) {
            return failure('version-conflict', state.version);
          }
          const vote = state.votes.find(
            (candidate) => candidate.studentReference === request.studentReference,
          );
          if (vote?.comparison !== 'tie') {
            return failure('tie-break-not-applicable', state.version);
          }

          // No official director identity/capability exists. Never infer ADMINISTRADOR as director.
          // The requested selection is deliberately not sent to the V1 decision workspace.
          return failure('tie-break-identity-unavailable', state.version);
        });
      } catch {
        return failure('unavailable');
      }
    },

    async close(request) {
      if (
        inspectCouncilInstitutionalRequestV2(request) !== 'ready' ||
        request.operation !== 'closure-close'
      ) {
        return failure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return failure('not-authorized');
      const key = sessionKey(request);

      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const state = await dependencies.sessions.getState(key);
          if (state.state === 'closed') return failure('already-closed', state.version);
          if (state.version !== request.expectedVersion) {
            return failure('version-conflict', state.version);
          }

          const candidate = await buildOpenReviewCandidate(dependencies, key, state);
          if (candidate.reviewReference !== request.reviewReference) {
            return failure('review-conflict', state.version);
          }
          if (candidate.blockers.length > 0) {
            return failure('closure-blocked', state.version, candidate.blockers);
          }

          const identity = dependencies.server.institutionalIdentity();
          if (!identityValid(identity)) return failure('unavailable', state.version);
          const result = await dependencies.sessions.close({
            academicYearId: request.academicYearId,
            classReference: request.classReference,
            expectedVersion: request.expectedVersion,
            reviewReference: candidate.reviewReference,
            items: candidate.items,
            actorReference: identity.actorReference,
            closedAt: identity.occurredAt,
          });
          if (result.status === 'already-closed') {
            return failure('already-closed', result.currentVersion);
          }
          if (result.status === 'version-conflict') {
            return failure('version-conflict', result.currentVersion);
          }
          return {
            contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
            outcome: 'closed' as const,
            version: result.version,
            snapshot: result.snapshot,
          };
        });
      } catch (error) {
        return failure(sourceFailureOutcome(error));
      }
    },

    async history(request) {
      if (
        inspectCouncilInstitutionalRequestV2(request) !== 'ready' ||
        request.operation !== 'closure-history'
      ) {
        return failure('invalid-request');
      }
      if (!dependencies.server.isAuthorized()) return failure('not-authorized');
      const key = sessionKey(request);

      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const [state, entries] = await Promise.all([
            dependencies.sessions.getState(key),
            dependencies.sessions.getHistory(key),
          ]);
          return {
            contractVersion: COUNCIL_INSTITUTIONAL_CONTRACT_VERSION_V2,
            outcome: 'closure-history' as const,
            academicYearId: request.academicYearId,
            classReference: request.classReference,
            meeting: meetingSummary(state),
            entries,
          };
        });
      } catch {
        return failure('unavailable');
      }
    },

    async decide(request) {
      if (!dependencies.server.isAuthorized()) return decisionNotAuthorized();
      const key = sessionKey(request);
      try {
        return await dependencies.sessions.runExclusive(key, async () => {
          const state = await dependencies.sessions.getState(key);
          if (state.state === 'closed') return decisionUnavailable();
          const response = await dependencies.workspace.decide(request);
          if (response.outcome === 'applied') {
            const touched = await dependencies.sessions.touchOpen(key);
            if (touched.status === 'closed') return decisionUnavailable();
          }
          return response;
        });
      } catch {
        return {
          contractVersion: COUNCIL_WORKSPACE_CONTRACT_VERSION_V1,
          outcome: 'unavailable',
          currentVersion: null,
        };
      }
    },
  };
}
