import { z } from 'zod';
import {
  assessmentLabelV1,
  assessmentNamesSchemaV1,
} from '../../../shared/gradebook-contracts/settings/assessment-names-v1';
import {
  academicStudentSchemaV1,
  type AcademicStudentReaderV1,
  type AcademicStudentV1,
  type academicMarkSchemaV1,
} from '../../../shared/gradebook-contracts/student-portal/academic-student-reader-v1';
import {
  academicVersionSchemaV1,
  portalAcademicLinkSchemaV1,
  type PortalAcademicLinkV1,
} from '../../../shared/gradebook-contracts/student-portal/academic-revision-v1';
import { resolveEligibilityV1 } from '../../../shared/gradebook-contracts/student-portal/eligibility-v1';
import { compareSourceSubjectPresentationV1 } from '../../../shared/gradebook-contracts/source/subject-abbreviations-v1';
import type { AcademicStudentReaderPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import {
  selfResponseV1,
  type SelfResponseV1,
} from '../../../shared/student-portal-contracts/self-v1';
import {
  resolveSimplifiedTermV1,
  resolveSimplifiedComponentRecoveryV1,
  SIMPLIFIED_TERM_MAXIMUM_MILLI_V1,
  type SimplifiedAcademicTermV1,
  type SimplifiedInstrumentSlotV1,
} from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import { resolveSimplifiedAnnualOutcomeV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-annual-outcome-v1';
import { resolveStudentMarkPresentationV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-student-mark-presentation-v1';
import { ACTIVE_INSTRUMENT_PREDICATE_V1 } from '../../gradebook/persistence/postgres/active-instrument-predicate-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { evaluateTermClosingV1, evaluateTermProgressV1, type TermClosingEvaluationV1 } from './term-closing-v1';

// Preserve the official predicate verbatim apart from its relation adapter. Evidence is
// instrument-wide, but only this student's value is ever selected into the snapshot.
const activeInstrument = ACTIVE_INSTRUMENT_PREDICATE_V1.replace(
  'gradebook.nota evidence',
  '(SELECT assessment_id AS instrumento_id FROM student_portal.academic_mark_v1) evidence',
);

export const ACADEMIC_STUDENT_QUERY_V1 = `WITH context AS (
  SELECT a.id AS account_id,s.name,r.academic_generation||':'||r.academic_counter::text AS data_version,
    y.minimum_approval,y.max_council_components,COALESCE(to_jsonb(y)->'assessment_names','{}'::jsonb) AS assessment_names,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('academicYear',b.academic_year,'studentId',b.student_id,
      'classId',b.class_id,'status',b.status,'classLabel',b.class_name)) FROM student_portal.academic_binding_v1 b
      WHERE b.academic_year=$1 AND b.student_id=$2 AND b.status IS DISTINCT FROM 6),'[]'::jsonb) AS bindings,
    (SELECT decision FROM student_portal.academic_council_decision_v1 WHERE academic_year=$1 AND student_id=$2) AS decision
  FROM student_portal.account a JOIN student_portal.academic_student_v1 s
    ON s.student_id=a.gradebook_student_id AND s.academic_year=a.academic_year
  JOIN student_portal.academic_revision r ON r.academic_year=a.academic_year
  JOIN student_portal.academic_year_policy_v1 y ON y.academic_year=a.academic_year
  WHERE a.academic_year=$1 AND a.gradebook_student_id=$2 AND a.closed_at IS NULL
), target AS (SELECT *,CASE WHEN jsonb_array_length(bindings)=1 THEN (bindings->0->>'classId')::integer ELSE NULL END AS class_id FROM context)
SELECT target.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'offerId',o.offer_id,'subjectId',o.subject_id,'label',o.subject_label,
  'instruments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'term',i.trimestre,'slot',i.slot,
      'maximum',i.maximo,'label',i.descricao,'value',n.value,'observed',n.assessment_id IS NOT NULL) ORDER BY i.trimestre,i.slot)
    FROM (SELECT assessment_id AS id,offer_id AS oferta_id,term AS trimestre,slot,maximum AS maximo,label AS descricao
      FROM student_portal.academic_instrument_v1) i
    LEFT JOIN student_portal.academic_mark_v1 n ON n.assessment_id=i.id AND n.student_id=$2
    WHERE i.oferta_id=o.offer_id AND ${activeInstrument}),'[]'::jsonb),
  'closure',(SELECT jsonb_build_object('am1',f.am1_fonte,'am2',f.am2_fonte,'am3',f.am3_fonte,
    'rec1',f.rec1,'rec2',f.rec2,'rec3',f.rec3,'nc',f.rec_nc_mask,'rr',f.rec_rr_mask,'annual',f.u_fonte)
    FROM student_portal.academic_closure_v1 f WHERE f.offer_id=o.offer_id AND f.student_id=$2)))
  FROM (SELECT * FROM student_portal.academic_offer_v1 WHERE academic_year=$1 AND class_id=target.class_id
    ORDER BY offer_id LIMIT 101) o),'[]'::jsonb) AS offers FROM target`;

const milli = z.number().int().safe().nonnegative();
const id = z.number().int().safe().positive();
const instrumentSchema = z.object({
  id,
  term: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  slot: id,
  maximum: milli.positive().nullable(),
  value: milli.nullable(),
  label: z.string().nullable(),
  observed: z.boolean().default(false),
});
const closureSchema = z.object({
  am1: milli.nullable(),
  am2: milli.nullable(),
  am3: milli.nullable(),
  rec1: milli.nullable(),
  rec2: milli.nullable(),
  rec3: milli.nullable(),
  nc: z.number().int().min(0).max(7),
  rr: z.number().int().min(0).max(7),
  annual: milli.nullable(),
});
const offerSchema = z.object({
  offerId: id,
  subjectId: id,
  label: z.string().min(1).max(120),
  instruments: z.array(instrumentSchema).max(39),
  closure: closureSchema.nullable(),
});
type Mark = z.infer<typeof academicMarkSchemaV1>;

/** Preserve the regular-instrument coverage used by official Portal editions before #848.
 * Only recovery/authority consume this adapter; current descriptive coverage and all numbers remain unchanged.
 */
function officialEditionTermV1(term: ReturnType<typeof resolveSimplifiedTermV1>) {
  const missingSlots = term.coverage.missingSlots.filter((slot) => slot !== 3);
  return {
    ...term,
    coverage: {
      ...term.coverage,
      requiredSlots: term.coverage.requiredSlots.filter((slot) => slot !== 3),
      resolvedSlots: term.coverage.resolvedSlots.filter((slot) => slot !== 3),
      missingSlots,
      complete: term.coverage.complete,
      reasons: term.coverage.reasons.filter((reason) => reason !== 'missing-slot:3'),
    },
  };
}

function mark(
  value: number | null,
  maximumMilli: number | null,
  minimumApprovalMilli: number,
): Mark {
  return value === null
    ? { kind: 'absent' }
    : {
        kind: 'score',
        valueMilli: value,
        maximumMilli,
        meetsMinimum: resolveStudentMarkPresentationV1({
          valueMilli: value,
          maximumMilli,
          minimumApprovalMilli,
        }),
      };
}

type AnnualSituationV1 = NonNullable<AcademicStudentV1['profile']['annualSituation']>;
type SubjectSituationV1 = NonNullable<AcademicStudentV1['subjects'][number]['annualSituation']>;
type AnnualOutcomeV1 = ReturnType<typeof resolveSimplifiedAnnualOutcomeV1>;

const VISIBLE_ANNUAL_SITUATION_V1: Partial<
  Record<NonNullable<AnnualOutcomeV1['visibleResult']>, AnnualSituationV1>
> = {
  'EM RECUPERAÇÃO': 'in-recovery',
  'APROVADO DIRETO': 'approved-direct',
  'APROVADO PELA RECUPERAÇÃO': 'approved-after-recovery',
  APROVADO: 'approved-special',
  'REPROVADO APÓS RECUPERAÇÃO': 'failed-after-recovery',
  'REPROVADO POR NÃO COMPARECIMENTO': 'failed-no-show',
  REPROVADO: 'failed-repeat',
};
const COUNCIL_SITUATION_V1: Record<1 | 2 | 3, AnnualSituationV1> = {
  1: 'approved-by-council',
  2: 'failed-by-council',
  3: 'failed-by-absence',
};

/**
 * Relays the BN's own annual verdict with its exact wording; no new rule. A formal Council
 * decision prevails (same precedence as `result`); EM CURSO and terminal enrollment statuses
 * (desistente/transferido/falecido) carry no situation, and ASSISTIDO never has one.
 * Owner decision (2026-09-23): there is no "awaiting Council" status for students. A student
 * eligible for the Council stays EM RECUPERAÇÃO until the final result, before or after it.
 */
export function annualSituationV1(input: {
  status: number | null;
  formalDecision: number | null;
  annual: AnnualOutcomeV1;
}): AnnualSituationV1 | undefined {
  if (input.status === 2) return undefined;
  if (input.formalDecision === 1 || input.formalDecision === 2 || input.formalDecision === 3)
    return COUNCIL_SITUATION_V1[input.formalDecision];
  if (input.annual.state === 'council-eligible') return 'in-recovery';
  return input.annual.visibleResult === null
    ? undefined
    : VISIBLE_ANNUAL_SITUATION_V1[input.annual.visibleResult];
}

export function subjectSituationV1(
  status: number | null,
  classification: string,
): SubjectSituationV1 | undefined {
  if (status === 2) return undefined;
  return (
    [
      'recovery-pending',
      'approved-direct',
      'approved-after-recovery',
      'not-approved',
      'failed-no-show',
      'failed-repeat',
    ] as const
  ).find((item) => item === classification);
}

/** Explicit projection: internal annual facts, class id and source metadata never spread to self. */
export function academicToSelfV1(
  student: AcademicStudentV1,
  accountId: string,
): Pick<SelfResponseV1, 'profile' | 'subjects'> {
  const source = academicStudentSchemaV1.parse(student);
  const convert = (value: Mark): SelfResponseV1['subjects'][number]['periods'][number]['final'] =>
    value.kind === 'score'
      ? {
          kind: 'score',
          value: value.valueMilli / 1000,
          maximum: value.maximumMilli === null ? null : value.maximumMilli / 1000,
          meetsMinimum: value.meetsMinimum,
        }
      : { kind: value.kind };
  const profile = selfResponseV1.shape.profile.parse({
    accountId,
    link: source.link,
    name: source.profile.name,
    classLabel: source.profile.classLabel,
    academicState: source.profile.academicState,
    result: source.profile.result,
    ...(source.profile.annualSituation === undefined
      ? {}
      : { annualSituation: source.profile.annualSituation }),
  });
  const subjects = selfResponseV1.shape.subjects.parse(
    source.subjects.map((subject) => ({
      subjectId: subject.subjectId,
      label: subject.label,
      order: subject.order,
      ...(subject.officialOutcome === undefined
        ? {}
        : { officialOutcome: subject.officialOutcome }),
      ...(subject.annualSituation === undefined
        ? {}
        : { annualSituation: subject.annualSituation }),
      periods: subject.periods.map((period) => ({
        period: period.period,
        final: convert(period.final),
        ...(period.partials === undefined
          ? {}
          : {
              partials: period.partials.map((assessment) => ({
                assessmentId: assessment.assessmentId,
                label: assessment.label,
                mark: convert(assessment.mark),
                ...(assessment.notDone ? { notDone: true as const } : {}),
                ...(assessment.parallel ? { parallel: true as const } : {}),
                ...(assessment.assessment ? { assessment: true as const } : {}),
              })),
            }),
      })),
    })),
  );
  return { profile, subjects };
}

export class AcademicStudentReaderPostgresV1
  implements AcademicStudentReaderV1<StudentPortalPostgresQueryV1>, AcademicStudentReaderPortV1
{
  constructor(private readonly sql: StudentPortalPostgresQueryV1) {}

  async readOfficial(link: PortalAcademicLinkV1, expectedDataVersion: string) {
    const result = await this.snapshot(this.sql, link, expectedDataVersion);
    return result === null
      ? null
      : {
          dataVersion: result.student.dataVersion,
          ...academicToSelfV1(result.student, result.accountId),
        };
  }

  async readOfficialInTransaction(
    tx: StudentPortalPostgresQueryV1,
    link: PortalAcademicLinkV1,
    expectedDataVersion: string,
  ): Promise<AcademicStudentV1 | null> {
    return (await this.snapshot(tx, link, expectedDataVersion))?.student ?? null;
  }

  /** Internal disclosure evidence; never part of the student DTO or a second academic calculation. */
  async readPublicationSourceInTransaction(
    tx: StudentPortalPostgresQueryV1,
    link: PortalAcademicLinkV1,
    expectedDataVersion: string,
  ) {
    const result = await this.snapshot(tx, link, expectedDataVersion);
    return result === null
      ? null
      : { student: result.student, finalAuthority: result.finalAuthority };
  }

  private async snapshot(
    tx: StudentPortalPostgresQueryV1,
    input: PortalAcademicLinkV1,
    expectedDataVersion: string,
  ) {
    const link = portalAcademicLinkSchemaV1.parse(input);
    academicVersionSchemaV1.parse(expectedDataVersion);
    const rows = await tx.unsafe(ACADEMIC_STUDENT_QUERY_V1, [link.academicYear, link.studentId]);
    if (rows.length !== 1 || rows[0]!.data_version !== expectedDataVersion) return null;
    return this.projectPreparedSourceV2(link, expectedDataVersion, rows[0]!);
  }

  /** The same validated engine consumes a stored edition, without querying current marks or another account. */
  projectPreparedSourceV2(
    input: PortalAcademicLinkV1,
    expectedDataVersion: string,
    row: Record<string, unknown>,
  ) {
    const link = portalAcademicLinkSchemaV1.parse(input);
    academicVersionSchemaV1.parse(expectedDataVersion);
    if (row.data_version !== expectedDataVersion) return null;
    const bindings = z
      .array(
        z.object({
          academicYear: z.literal(2026),
          studentId: id,
          classId: id,
          status: z.union([
            z.null(),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(7),
          ]),
          classLabel: z.string().min(1).max(80),
        }),
      )
      .parse(row.bindings);
    const eligibility = resolveEligibilityV1(
      link,
      expectedDataVersion,
      bindings.map(({ classLabel: _label, ...binding }) => binding),
    );
    if (eligibility.state !== 'eligible' || eligibility.current === null) return null;
    const status = eligibility.current.status;
    const minimum = milli.positive().parse(row.minimum_approval);
    const names = assessmentNamesSchemaV1.parse(row.assessment_names ?? {});
    const maxCouncil = milli.parse(row.max_council_components);
    const decision = z
      .union([z.null(), z.literal(1), z.literal(2), z.literal(3)])
      .parse(row.decision);
    const offers = z
      .array(offerSchema)
      .max(100)
      .parse(row.offers)
      .sort(
        (a, b) =>
          compareSourceSubjectPresentationV1(a.label, b.label) ||
          a.subjectId - b.subjectId ||
          a.offerId - b.offerId,
      );
    const projections = offers.map((offer, order) => {
      const terms = ([1, 2, 3] as const).map((term) =>
        resolveSimplifiedTermV1({
          term,
          instruments: offer.instruments
            .filter((item) => item.term === term)
            .map((item) => ({
              slot: item.slot as SimplifiedInstrumentSlotV1,
              maximumMilli: item.maximum,
              valueMilli: item.value,
            })),
        }),
      ) as unknown as Parameters<typeof resolveSimplifiedComponentRecoveryV1>[0]['terms'];
      const officialTerms = terms.map(officialEditionTermV1) as unknown as typeof terms;
      const recoveryValue = (term: SimplifiedAcademicTermV1) => {
        const closure = offer.closure;
        if (closure === null) return null;
        const bit = 1 << (term - 1);
        if ((closure.rr & bit) !== 0) {
          return 'RR' as const;
        }
        if ((closure.nc & bit) !== 0) {
          return 'NC' as const;
        }
        return closure[`rec${term}`];
      };
      const recovery = resolveSimplifiedComponentRecoveryV1({
        terms: officialTerms,
        minimumApprovalMilli: minimum,
        recovery: { 1: recoveryValue(1), 2: recoveryValue(2), 3: recoveryValue(3) },
      });
      const periods: AcademicStudentV1['subjects'][number]['periods'] = ([1, 2, 3] as const).map(
        (term) => ({
          period: `T${term}`,
          final: mark(
            offer.closure?.[`am${term}`] ?? null,
            SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term],
            minimum,
          ),
          partials: offer.instruments
            .filter((item) =>
              item.term === term &&
              (item.slot !== 3 || terms[term - 1]!.parallelApplicable === true),
            )
            .map((item) => ({
              assessmentId: item.id,
              label: assessmentLabelV1(item.slot, term, names, item.label),
              // The parallel exam has no maximum of its own: it stands in for AV1+AV2, so the
              // engine grades it against their combined maximum and the student sees that one.
              mark: mark(
                item.value,
                item.slot === 3
                  ? (item.maximum ?? terms[term - 1]!.quantitativeMaximumMilli)
                  : item.maximum,
                minimum,
              ),
              ...(item.observed && item.value === null ? { notDone: true as const } : {}),
              ...(item.slot === 3 ? { parallel: true as const } : {}),
              // Columns R and S: the assessments, named in the Banco de Notas settings.
              ...(item.slot === 1 || item.slot === 2 ? { assessment: true as const } : {}),
            })),
        }),
      );
      for (const term of [1, 2, 3] as const) {
        const rec = recovery.recoveryTerms[term];
        if (rec.applicable !== true) continue;
        periods.push({
          period: `REC${term}`,
          final:
            rec.source === 'RR'
              ? { kind: 'rr' }
              : rec.source === 'NC'
                ? { kind: 'nc' }
                : rec.source === null
                  ? { kind: 'recovery-pending' }
                  : mark(rec.source, SIMPLIFIED_TERM_MAXIMUM_MILLI_V1[term], minimum),
        });
      }
      const classification = recovery.classification;
      let officialOutcome;
      if (status === 2) {
        officialOutcome = undefined;
      } else if (classification === 'approved-direct' || classification === 'approved-after-recovery') {
        officialOutcome = 'approved' as const;
      } else if (['not-approved', 'failed-no-show', 'failed-repeat'].includes(classification)) {
        officialOutcome = 'failed' as const;
      } else {
        officialOutcome = undefined;
      }
      const situation = subjectSituationV1(status, classification);
      // Fechamento do trimestre (#1132): codes from the same official term outcomes and facts.
      // Both readings are cheap; Self picks one by the `termClosingConclusive` policy.
      const closings = ([1, 2, 3] as const).flatMap((term) => {
        const input = {
          term,
          outcome: terms[term - 1]!,
          officialTotalMilli: offer.closure?.[`am${term}`] ?? null,
          instruments: offer.instruments.filter((item) => item.term === term),
          minimumApprovalMilli: minimum,
          recoveryPending: classification === 'recovery-pending',
        };
        return [evaluateTermClosingV1(input), evaluateTermProgressV1(input)].filter(
          (evaluation): evaluation is TermClosingEvaluationV1 => evaluation !== null,
        );
      });
      const sourceComplete =
        offer.closure?.annual !== null &&
        offer.closure?.annual !== undefined &&
        terms.every(
          (term) =>
            offer.closure?.[`am${term.term}`] !== null &&
            offer.closure?.[`am${term.term}`] !== undefined,
        );
      const sourceAgrees =
        sourceComplete &&
        officialTerms.every(
          (term) =>
            term.coverage.complete && offer.closure?.[`am${term.term}`] === term.roundedMilli,
        ) &&
        offer.closure?.annual === recovery.postRecoveryTotalMilli;
      return {
        recovery,
        sourceComplete,
        sourceAgrees,
        closings,
        subject: {
          subjectId: offer.subjectId,
          label: offer.label,
          order,
          periods,
          officialAnnual: mark(offer.closure?.annual ?? null, null, minimum),
          ...(officialOutcome === undefined ? {} : { officialOutcome }),
          ...(situation === undefined ? {} : { annualSituation: situation }),
        },
      };
    });
    const annual = resolveSimplifiedAnnualOutcomeV1({
      status,
      components: projections.map((item) => item.recovery),
      maxCouncilComponents: maxCouncil,
    });
    const hasRepeat = projections.some((item) => item.recovery.classification === 'failed-repeat');
    const formal = (status === null || status === 7) && !hasRepeat ? decision : null;
    let result: 'not-applicable' | 'approved' | 'failed' | 'failed-attendance' | 'in-progress';
    if (status === 2) {
      result = 'not-applicable';
    } else if (formal === 1) {
      result = 'approved';
    } else if (formal === 2) {
      result = 'failed';
    } else if (formal === 3) {
      result = 'failed-attendance';
    } else if (annual.visibleResult?.startsWith('APROVADO')) {
      result = 'approved';
    } else if (annual.visibleResult?.startsWith('REPROVADO')) {
      result = 'failed';
    } else {
      result = 'in-progress';
    }
    const annualSituation = annualSituationV1({ status, formalDecision: formal, annual });
    const student = academicStudentSchemaV1.parse({
      contractVersion: 1,
      link,
      dataVersion: expectedDataVersion,
      profile: {
        name: row.name,
        classId: eligibility.current.classId,
        classLabel: bindings[0]!.classLabel,
        academicState: status === 2 ? 'assisted' : status === 1 ? 'special' : 'regular',
        result,
        ...(annualSituation === undefined ? {} : { annualSituation }),
      },
      subjects: projections.map((item) => item.subject),
    });
    return {
      student,
      accountId: z.uuid().parse(row.account_id),
      /** Internal closing codes per subject; exposed only through the Self closing rules. */
      closings: new Map<number, readonly TermClosingEvaluationV1[]>(
        projections.map((item) => [item.subject.subjectId, item.closings]),
      ),
      finalAuthority: {
        global:
          status === 1 ||
          (projections.length > 0 &&
            projections.every((item) => item.sourceComplete) &&
            (formal !== null || hasRepeat || projections.every((item) => item.sourceAgrees))),
        subjectIds: projections
          .filter((item) => item.sourceAgrees)
          .map((item) => item.subject.subjectId),
      },
    };
  }
}
