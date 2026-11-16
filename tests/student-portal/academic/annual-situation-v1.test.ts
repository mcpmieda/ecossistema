// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  annualSituationV1,
  subjectSituationV1,
} from '../../../server/student-portal/academic/academic-reader-v1';
import type { SimplifiedAnnualOutcomeV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';

const annual = (
  visibleResult: SimplifiedAnnualOutcomeV1['visibleResult'],
  state: SimplifiedAnnualOutcomeV1['state'] = 'final',
): SimplifiedAnnualOutcomeV1 => ({
  state,
  visibleResult,
  failedComponentCount: 0,
  approvedDirectComponentCount: 0,
  approvedAfterRecoveryComponentCount: 0,
  councilEligibility: 'not-applicable',
  reasons: [],
});

describe('official annual situation relay', () => {
  it('maps every BN visible result to its exact situation without new rules', () => {
    const relay = (result: SimplifiedAnnualOutcomeV1['visibleResult'], state?: SimplifiedAnnualOutcomeV1['state']) =>
      annualSituationV1({ status: null, formalDecision: null, annual: annual(result, state) });
    expect(relay('EM CURSO', 'in-progress')).toBeUndefined();
    expect(relay('EM RECUPERAÇÃO', 'recovery')).toBe('in-recovery');
    expect(relay('APROVADO DIRETO')).toBe('approved-direct');
    expect(relay('APROVADO PELA RECUPERAÇÃO')).toBe('approved-after-recovery');
    expect(relay('REPROVADO APÓS RECUPERAÇÃO')).toBe('failed-after-recovery');
    expect(relay('REPROVADO POR NÃO COMPARECIMENTO')).toBe('failed-no-show');
    expect(relay('REPROVADO')).toBe('failed-repeat');
    expect(relay('APROVADO')).toBe('approved-special');
    // No "awaiting Council" status: the student stays EM RECUPERAÇÃO until the final result.
    expect(relay(null, 'council-eligible')).toBe('in-recovery');
    for (const terminal of ['DESISTENTE', 'TRANSFERIDO', 'FALECIDO'] as const)
      expect(relay(terminal)).toBeUndefined();
  });

  it('lets a formal Council decision prevail and never gives ASSISTIDO a situation', () => {
    const pending = annual(null, 'council-eligible');
    expect(annualSituationV1({ status: null, formalDecision: 1, annual: pending })).toBe('approved-by-council');
    expect(annualSituationV1({ status: 7, formalDecision: 2, annual: pending })).toBe('failed-by-council');
    expect(annualSituationV1({ status: null, formalDecision: 3, annual: pending })).toBe('failed-by-absence');
    expect(annualSituationV1({ status: 2, formalDecision: null, annual: annual('APROVADO DIRETO') })).toBeUndefined();
  });

  it('relays component classifications and omits in-progress and ASSISTIDO', () => {
    expect(subjectSituationV1(null, 'recovery-pending')).toBe('recovery-pending');
    expect(subjectSituationV1(null, 'approved-after-recovery')).toBe('approved-after-recovery');
    expect(subjectSituationV1(null, 'not-approved')).toBe('not-approved');
    expect(subjectSituationV1(null, 'in-progress')).toBeUndefined();
    expect(subjectSituationV1(2, 'approved-direct')).toBeUndefined();
  });
});
