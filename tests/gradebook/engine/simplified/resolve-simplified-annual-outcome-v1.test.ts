// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  effectiveCouncilDecisionV1,
  resolveSimplifiedAnnualOutcomeV1,
  type SimplifiedEnrollmentStatusV1,
} from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import type { SimplifiedComponentRecoveryOutcomeV1 } from '../../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';

function component(
  classification: SimplifiedComponentRecoveryOutcomeV1['classification'],
): SimplifiedComponentRecoveryOutcomeV1 {
  return {
    originalTotalMilli: 0,
    originalComplete: classification !== 'in-progress',
    recoveryRequired:
      classification === 'approved-direct' ? false : classification === 'in-progress' ? null : true,
    recoveryTerms: {
      1: { term: 1, applicable: false, source: null, replacementMilli: 0 },
      2: { term: 2, applicable: false, source: null, replacementMilli: 0 },
      3: { term: 3, applicable: false, source: null, replacementMilli: 0 },
    },
    postRecoveryTotalMilli: classification === 'recovery-pending' || classification === 'failed-no-show' || classification === 'failed-repeat' ? null : 0,
    classification,
    warnings: [],
  };
}

function resolve(input: {
  readonly status?: SimplifiedEnrollmentStatusV1;
  readonly components?: readonly SimplifiedComponentRecoveryOutcomeV1[];
  readonly maxCouncilComponents?: number;
}) {
  return resolveSimplifiedAnnualOutcomeV1({
    status: input.status ?? null,
    components: input.components ?? [],
    maxCouncilComponents: input.maxCouncilComponents ?? 2,
  });
}

describe('simplified annual outcome v1', () => {
  it('applies the approved special-status precedence before academic calculations', () => {
    expect(resolve({ status: 2 }).visibleResult).toBeNull();
    expect(resolve({ status: 5 }).visibleResult).toBe('FALECIDO');
    expect(resolve({ status: 4 }).visibleResult).toBe('TRANSFERIDO');
    expect(resolve({ status: 3 }).visibleResult).toBe('DESISTENTE');
    expect(resolve({ status: 1 }).visibleResult).toBe('APROVADO');
  });

  it('keeps regular students in progress until component facts are ready', () => {
    expect(resolve({ components: [] })).toMatchObject({ state: 'in-progress', visibleResult: 'EM CURSO' });
    expect(resolve({ components: [component('approved-direct'), component('in-progress')] })).toMatchObject({
      state: 'in-progress',
      visibleResult: 'EM CURSO',
    });
  });

  it('returns EM RECUPERAÇÃO while any component still awaits final recovery', () => {
    expect(resolve({ components: [component('approved-direct'), component('recovery-pending')] })).toMatchObject({
      state: 'recovery',
      visibleResult: 'EM RECUPERAÇÃO',
    });
  });

  it('distinguishes direct approval from approval after recovery', () => {
    expect(resolve({ components: [component('approved-direct'), component('approved-direct')] }).visibleResult).toBe(
      'APROVADO DIRETO',
    );
    expect(
      resolve({ components: [component('approved-direct'), component('approved-after-recovery')] }).visibleResult,
    ).toBe('APROVADO PELA RECUPERAÇÃO');
  });

  it('makes a required REC N/C final and ineligible for Council', () => {
    expect(resolve({ components: [component('failed-no-show'), component('approved-direct')] })).toMatchObject({
      state: 'final',
      visibleResult: 'REPROVADO POR NÃO COMPARECIMENTO',
      councilEligibility: 'not-eligible',
    });
  });

  it('makes any R/R component REPROVADO and ineligible even while another recovery is pending', () => {
    expect(resolve({ components: [component('recovery-pending'), component('failed-repeat')] })).toMatchObject({
      state: 'final',
      visibleResult: 'REPROVADO',
      councilEligibility: 'not-eligible',
      reasons: ['component:failed-repeat'],
    });
  });

  it('enforces the configured failed-component Council limit', () => {
    expect(
      resolve({
        components: [component('not-approved'), component('not-approved'), component('not-approved')],
        maxCouncilComponents: 2,
      }),
    ).toMatchObject({
      state: 'final',
      visibleResult: 'REPROVADO APÓS RECUPERAÇÃO',
      councilEligibility: 'not-eligible',
      failedComponentCount: 3,
    });
  });

  it('exposes Council eligibility from the selected annual result only', () => {
    expect(
      resolve({ components: [component('not-approved')], maxCouncilComponents: 2 }),
    ).toMatchObject({
      state: 'council-eligible',
      visibleResult: null,
      councilEligibility: 'eligible',
    });
  });

  it('treats ESTAVA_NO as a current regular binding and rejects historical FOI_PARA', () => {
    expect(resolve({ status: 7, components: [component('approved-direct')] }).visibleResult).toBe('APROVADO DIRETO');
    expect(() => resolve({ status: 6, components: [component('approved-direct')] })).toThrow(/FOI_PARA/u);
  });

  it('keeps a Council decision only while the student is still sent to the Council', () => {
    const decided = 2; // REPROVADO PELO CONSELHO, recorded earlier
    const eligible = resolve({ components: [component('not-approved'), component('approved-direct')] });
    expect(eligible.councilEligibility).toBe('eligible');
    expect(effectiveCouncilDecisionV1(eligible, decided)).toBe(2);
    // A corrected grade approves the student: the old decision no longer applies.
    const approved = resolve({ components: [component('approved-after-recovery'), component('approved-direct')] });
    expect(effectiveCouncilDecisionV1(approved, decided)).toBeNull();
    // Failing more components than the limit, R/R and terminal statuses also leave it out.
    const aboveLimit = resolve({ components: [component('not-approved'), component('not-approved'), component('not-approved')] });
    expect(effectiveCouncilDecisionV1(aboveLimit, 1)).toBeNull();
    expect(effectiveCouncilDecisionV1(resolve({ components: [component('failed-repeat')] }), 1)).toBeNull();
    expect(effectiveCouncilDecisionV1(resolve({ status: 4, components: [component('not-approved')] }), 1)).toBeNull();
    expect(effectiveCouncilDecisionV1(null, 1)).toBeNull();
  });
});
