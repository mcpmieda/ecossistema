import type { SimplifiedComponentRecoveryOutcomeV1 } from './resolve-simplified-academic-engine-v1';

export type SimplifiedEnrollmentStatusV1 = null | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const SIMPLIFIED_VISIBLE_ANNUAL_RESULTS_V1 = [
  'EM CURSO',
  'APROVADO DIRETO',
  'EM RECUPERAÇÃO',
  'APROVADO PELA RECUPERAÇÃO',
  'REPROVADO APÓS RECUPERAÇÃO',
  'REPROVADO POR NÃO COMPARECIMENTO',
  'REPROVADO',
  'APROVADO',
  'DESISTENTE',
  'TRANSFERIDO',
  'FALECIDO',
] as const;
export type SimplifiedVisibleAnnualResultV1 =
  (typeof SIMPLIFIED_VISIBLE_ANNUAL_RESULTS_V1)[number];

export type SimplifiedAnnualProgressStateV1 =
  | 'no-result'
  | 'in-progress'
  | 'recovery'
  | 'final'
  | 'council-eligible';

export interface SimplifiedAnnualOutcomeInputV1 {
  readonly status: SimplifiedEnrollmentStatusV1;
  readonly components: readonly SimplifiedComponentRecoveryOutcomeV1[];
  readonly maxCouncilComponents: number;
}

export interface SimplifiedAnnualOutcomeV1 {
  readonly state: SimplifiedAnnualProgressStateV1;
  readonly visibleResult: SimplifiedVisibleAnnualResultV1 | null;
  readonly failedComponentCount: number;
  readonly approvedDirectComponentCount: number;
  readonly approvedAfterRecoveryComponentCount: number;
  readonly councilEligibility: 'not-applicable' | 'eligible' | 'not-eligible';
  readonly reasons: readonly string[];
}

function validate(input: SimplifiedAnnualOutcomeInputV1): void {
  if (!Number.isSafeInteger(input.maxCouncilComponents) || input.maxCouncilComponents < 0) {
    throw new RangeError('maxCouncilComponents must be a non-negative safe integer');
  }
  if (![null, 1, 2, 3, 4, 5, 6, 7].includes(input.status)) {
    throw new RangeError('unsupported enrollment status');
  }
}

function terminal(
  visibleResult: SimplifiedVisibleAnnualResultV1 | null,
  reason: string,
): SimplifiedAnnualOutcomeV1 {
  return {
    state: visibleResult === null ? 'no-result' : 'final',
    visibleResult,
    failedComponentCount: 0,
    approvedDirectComponentCount: 0,
    approvedAfterRecoveryComponentCount: 0,
    councilEligibility: 'not-applicable',
    reasons: [reason],
  };
}

/** Status precedence is independent from grades and Council calculations. */
function statusOutcomeV1(status: SimplifiedAnnualOutcomeInputV1['status']): SimplifiedAnnualOutcomeV1 | null {
  if (status === 2) return terminal(null, 'status:ASSISTIDO');
  if (status === 5) return terminal('FALECIDO', 'status:FALECIDO');
  if (status === 4) return terminal('TRANSFERIDO', 'status:TRANSFERIDO');
  if (status === 3) return terminal('DESISTENTE', 'status:DESISTENTE');
  if (status === 1) return terminal('APROVADO', 'status:ESPECIAL');
  if (status === 6) {
    throw new RangeError('FOI_PARA is a historical binding and cannot be resolved as the current annual status');
  }
  return null;
}

export function resolveSimplifiedAnnualOutcomeV1(
  input: SimplifiedAnnualOutcomeInputV1,
): SimplifiedAnnualOutcomeV1 {
  validate(input);

  const byStatus = statusOutcomeV1(input.status);
  if (byStatus) return byStatus;

  const approvedDirectComponentCount = input.components.filter(
    (component) => component.classification === 'approved-direct',
  ).length;
  const approvedAfterRecoveryComponentCount = input.components.filter(
    (component) => component.classification === 'approved-after-recovery',
  ).length;
  const failedComponentCount = input.components.filter(
    (component) => component.classification === 'not-approved' || component.classification === 'failed-repeat',
  ).length;

  const base = {
    failedComponentCount,
    approvedDirectComponentCount,
    approvedAfterRecoveryComponentCount,
  } as const;

  if (input.components.some((component) => component.classification === 'failed-repeat')) {
    return {
      ...base,
      state: 'final',
      visibleResult: 'REPROVADO',
      councilEligibility: 'not-eligible',
      reasons: ['component:failed-repeat'],
    };
  }

  if (
    input.components.length === 0 ||
    input.components.some((component) => component.classification === 'in-progress')
  ) {
    return {
      ...base,
      state: 'in-progress',
      visibleResult: 'EM CURSO',
      councilEligibility: 'not-applicable',
      reasons: input.components.length === 0 ? ['components:not-yet-available'] : ['component:in-progress'],
    };
  }

  if (input.components.some((component) => component.classification === 'recovery-pending')) {
    return {
      ...base,
      state: 'recovery',
      visibleResult: 'EM RECUPERAÇÃO',
      councilEligibility: 'not-applicable',
      reasons: ['component:recovery-pending'],
    };
  }

  if (input.components.some((component) => component.classification === 'failed-no-show')) {
    return {
      ...base,
      state: 'final',
      visibleResult: 'REPROVADO POR NÃO COMPARECIMENTO',
      councilEligibility: 'not-eligible',
      reasons: ['component:failed-no-show'],
    };
  }

  if (failedComponentCount === 0) {
    const afterRecovery = approvedAfterRecoveryComponentCount > 0;
    return {
      ...base,
      state: 'final',
      visibleResult: afterRecovery ? 'APROVADO PELA RECUPERAÇÃO' : 'APROVADO DIRETO',
      councilEligibility: 'not-applicable',
      reasons: [afterRecovery ? 'all-components-approved-after-recovery' : 'all-components-approved-direct'],
    };
  }

  if (failedComponentCount > input.maxCouncilComponents) {
    return {
      ...base,
      state: 'final',
      visibleResult: 'REPROVADO APÓS RECUPERAÇÃO',
      councilEligibility: 'not-eligible',
      reasons: [`failed-components:${failedComponentCount}:above-council-limit:${input.maxCouncilComponents}`],
    };
  }

  return {
    ...base,
    state: 'council-eligible',
    visibleResult: null,
    councilEligibility: 'eligible',
    reasons: [`failed-components:${failedComponentCount}:within-council-limit:${input.maxCouncilComponents}`],
  };
}
