import {
  EMPTY_PERFORMANCE_CLOSING_V2,
  performanceCellV2,
  projectPerformanceFactsV2,
  type PerformanceFactV2,
} from '../../../server/gradebook/application/results/relational-performance-facts-v2';
import { termRecoveryVisibilityV1 } from '../../../src/gradebook-domain/calculations/simplified/term-recovery-visibility-v1';
import type {
  PerformanceMatrixV2,
  PerformanceReadyV2,
} from '../../../shared/gradebook-contracts/performance/relational-performance-v2';

const TERMS = [1, 2, 3] as const;
export const PARALLEL_ACCOUNT_848 = '84800000-0000-4000-8000-000000000001';
export const PARALLEL_VERSION_848 = `${'8'.repeat(32)}:1`;
export interface ParallelOptions848 {
  term?: 1 | 2 | 3;
  studentId?: number;
  av1?: number | null;
  av2?: number | null;
  qualitative?: number | null;
  parallel?: number | null;
  observed?: boolean;
  includeParallel?: boolean;
}

/** Synthetic only. All derived academic results come from the production engine. */
export function parallelFixture848(options: ParallelOptions848 = {}) {
  const period = options.term ?? 2;
  const studentId = options.studentId ?? 848001;
  const facts: PerformanceFactV2[] = TERMS.flatMap((term) => {
    const selected = term === period;
    const avMaximum = term === 3 ? 9000 : 6750;
    const qualMaximum = term === 3 ? 22000 : 16500;
    const instruments: PerformanceFactV2[] = [
      {
        term,
        slot: 1,
        label: 'AV1 SINTETICA',
        maximumMilli: avMaximum,
        valueMilli: selected ? (options.av1 === undefined ? 2000 : options.av1) : avMaximum,
        observed: true,
      },
      {
        term,
        slot: 2,
        label: 'AV2 SINTETICA',
        maximumMilli: avMaximum,
        valueMilli: selected ? (options.av2 === undefined ? 2000 : options.av2) : avMaximum,
        observed: true,
      },
      {
        term,
        slot: 3,
        label: 'PARA',
        maximumMilli: null,
        valueMilli: selected ? (options.parallel ?? null) : null,
        observed: selected ? (options.observed ?? true) : true,
      },
      {
        term,
        slot: 11,
        label: 'ATIVIDADE SINTETICA',
        maximumMilli: qualMaximum,
        valueMilli: selected
          ? options.qualitative === undefined
            ? 10000
            : options.qualitative
          : qualMaximum,
        observed: true,
      },
    ];
    return instruments.filter((fact) => options.includeParallel !== false || fact.slot !== 3);
  });
  const closing = { ...EMPTY_PERFORMANCE_CLOSING_V2, am: [25000, 26000, 35000] as const, u: 86000 };
  const projection = projectPerformanceFactsV2(848001, facts, closing, 60000);
  const cell = performanceCellV2(projection, period, 'regular');
  const student = {
    id: studentId,
    name: 'ESTUDANTE SINTETICO',
    number: 1,
    status: null,
    statusLabel: 'Em curso',
    indicatorEligible: true,
  };
  const offer = {
    id: 848001,
    subject: { id: 848001, label: 'COMPONENTE SINTETICO' },
    teacher: { id: 848001, label: 'DOCENTE SINTETICO' },
  };
  const common = {
    transportVersion: 2 as const,
    state: 'ready' as const,
    context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
    classGroup: { id: 848001, label: 'TURMA SINTETICA' },
    period,
    mode: 'regular' as const,
    authority: 'calculated-preview' as const,
    readAt: '2026-09-18T00:00:00.000Z',
  };
  const matrix: PerformanceMatrixV2 = {
    ...common,
    operation: 'matrix',
    offers: [offer],
    rows: [{ student, calculatedAnnual: null, formalCouncilDecision: null, cells: [cell] }],
    comparison: { available: false, reason: 'comparability-not-contracted' },
    statistics: {
      classRows: 1,
      visibleRows: 1,
      eligibleRows: 1,
      recoveryUnknownRows: cell.recoveryApplicable === null ? 1 : 0,
      consideredCells: 1,
      completeCells: cell.state === 'complete' ? 1 : 0,
      noShowCells: 0,
      incompleteCells: cell.state === 'complete' ? 0 : 1,
      attentionRows: cell.level === 'below' ? 1 : 0,
    },
  };
  type Detail = Extract<PerformanceReadyV2, { operation: 'cell-detail' }>;
  const detail: Detail = {
    ...common,
    operation: 'cell-detail',
    student,
    offer,
    terms: TERMS.map((term) => {
      const outcome = projection.terms[term - 1]!;
      return {
        term,
        hasGrades: term === period,
        ...termRecoveryVisibilityV1(
          outcome,
          projection.recovery?.recoveryTerms[term].applicable ?? null,
        ),
        regular: performanceCellV2(projection, term, 'regular'),
        recovery: performanceCellV2(projection, term, 'recovery'),
        quantitativeOriginalMilli: outcome.quantitativeOriginalMilli,
        quantitativeConsideredMilli: outcome.quantitativeConsideredMilli,
        qualitativeMilli: outcome.qualitativeOperationalMilli,
        parallelMilli: outcome.parallelMilli,
        parallelApplicable: outcome.parallelApplicable,
        instruments: facts
          .filter((fact) => fact.term === term)
          .map((fact) => ({
            slot: fact.slot,
            label: fact.label,
            maximumMilli: fact.maximumMilli,
            valueMilli: fact.valueMilli,
            ...(fact.observed && fact.valueMilli === null ? { notDone: true as const } : {}),
          })),
      };
    }) as unknown as Detail['terms'],
  };
  const portalSource = {
    account_id: PARALLEL_ACCOUNT_848,
    data_version: PARALLEL_VERSION_848,
    name: student.name,
    minimum_approval: 60000,
    max_council_components: 2,
    decision: null,
    assessment_names: {},
    bindings: [
      {
        academicYear: 2026,
        studentId,
        classId: 848001,
        status: null,
        classLabel: 'TURMA SINTETICA',
      },
    ],
    offers: [
      {
        offerId: offer.id,
        subjectId: offer.subject.id,
        label: offer.subject.label,
        instruments: facts.map((fact) => ({
          id: 8480000 + fact.term * 100 + fact.slot,
          term: fact.term,
          slot: fact.slot,
          maximum: fact.maximumMilli,
          value: fact.valueMilli,
          label: fact.label,
          observed: fact.observed,
        })),
        closure: {
          am1: closing.am[0],
          am2: closing.am[1],
          am3: closing.am[2],
          rec1: null,
          rec2: null,
          rec3: null,
          nc: 0,
          rr: 0,
          annual: closing.u,
        },
      },
    ],
  };
  return {
    facts,
    projection,
    cell,
    matrix,
    detail,
    portalSource,
    projections: new Map([[studentId, [projection]]]),
    link: { academicYear: 2026 as const, studentId },
  };
}
