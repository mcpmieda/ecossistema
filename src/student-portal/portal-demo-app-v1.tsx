import { useMemo, useState, type CSSProperties } from 'react';
import { StudentPortalPageV1 } from '../features/student-portal/shell/student-shell-v1';
import { PortalSignedInNoticesV1 } from '../features/student-portal/shell/portal-notices-v1';
import {
  createDemoFrequencyClientV3,
  createDemoScheduleClientV3,
  DEMO_FREQUENCY_COMMENTS_V3,
  type DemoCommentChoiceV3,
} from './redesign-preview/demo-data-v3';
import { selfResponseV1, type SelfResponseV1 } from '../../shared/student-portal-contracts/self-v1';
import '../features/student-portal/shared/styles.css';


const previewPortrait = new URL('./assets/demo-student-boy.webp', import.meta.url).href;

/*
 * Invented preview data only. It mirrors the server rules so the UI shows realistic states:
 * - trimester maxima 30/30/40 (SIMPLIFIED_TERM_MAXIMUM_MILLI_V1);
 * - meetsMinimum = value / maximum >= 60% (resolveStudentMarkPresentationV1 with the
 *   synthetic minimum used in tests); no maximum → null (neutral);
 * - notDone only for an observed blank (mark absent); numeric 0 stays a score ("Tirou zero");
 * - generatedAt is in September, so T3 is in progress: some partials, final not yet released;
 * - REC exists only for terms below the minimum, pending or scored against the term maximum.
 */
const MINIMUM_PERCENT = 60;
const TERM_MAXIMUM = { T1: 30, T2: 30, T3: 40 } as const;

const score = (value: number, maximum: number) => ({
  kind: 'score' as const,
  value,
  maximum,
  meetsMinimum: value * 100 >= maximum * MINIMUM_PERCENT,
});
const absent = { kind: 'absent' as const };
let nextAssessmentId = 910000;
// In the example data the two assessments (columns R and S) are the ones named "Avaliação N".
const partial = (label: string, value: number, maximum: number) => ({
  assessmentId: ++nextAssessmentId,
  label,
  mark: score(value, maximum),
  ...(/^Avaliação \d/u.test(label) ? { assessment: true as const } : {}),
});
const notDone = (label: string) => ({
  assessmentId: ++nextAssessmentId,
  label,
  mark: absent,
  notDone: true as const,
});
type PartialV1 = ReturnType<typeof partial> | ReturnType<typeof notDone>;
const term = (period: 'T1' | 'T2', final: number, partials: PartialV1[]) => ({
  period,
  final: score(final, TERM_MAXIMUM[period]),
  partials,
});
const ongoingT3 = (partials: PartialV1[]) => ({ period: 'T3' as const, final: absent, partials });
const recovery = (period: 'REC1' | 'REC2', value?: number) => ({
  period,
  final:
    value === undefined
      ? { kind: 'recovery-pending' as const }
      : score(value, TERM_MAXIMUM[period === 'REC1' ? 'T1' : 'T2']),
});

const previewData = selfResponseV1.parse({
  contractVersion: 1,
  requestId: '11111111-1111-4111-8111-111111111111',
  state: 'ready',
  profile: {
    accountId: '11111111-1111-4111-8111-111111111111',
    link: { academicYear: 2026, studentId: 900001 },
    name: 'Pedro Henrique Almeida',
    classLabel: '1ª Série do Ensino Médio',
    academicState: 'regular',
    result: 'in-progress',
  },
  revisions: {
    dataVersion: 'preview:academic:1',
    policyVersion: 'preview:policy:1',
    publicationVersion: 'preview:publication:1',
  },
  generatedAt: '2026-09-20T12:00:00-03:00',
  subjects: [
    {
      subjectId: 900001,
      label: 'Matemática',
      order: 1,
      periods: [
        term('T1', 16.5, [
          partial('Avaliação 1', 5, 10),
          partial('Avaliação 2', 5, 10),
          partial('Lista de exercícios: conjuntos numéricos', 2, 3),
          partial('Trabalho: porcentagem no dia a dia', 3.5, 4),
          partial('Participação em sala', 1, 3),
        ]),
        term('T2', 19.8, [
          partial('Avaliação 1', 7, 10),
          partial('Avaliação 2', 5.5, 10),
          partial('Atividade de resolução de problemas', 1.8, 2),
          partial('Lista de exercícios: funções do 1º grau', 1, 1),
          partial(
            // Near the contract maximum (120 characters): exercises long activity descriptions.
            'Projeto interdisciplinar: levantamento de dados sobre o consumo de água na escola, análise estatística e apresentação',
            2.5,
            3,
          ),
          partial('Participação em sala', 2, 3),
          partial('Quiz de revisão', 0, 1),
          notDone('Atividade de casa'),
        ]),
        ongoingT3([partial('Avaliação 1', 6, 15), partial('Lista de exercícios: função quadrática', 2, 3)]),
        recovery('REC1', 19),
      ],
    },
    {
      subjectId: 900002,
      label: 'Língua Portuguesa',
      order: 2,
      periods: [
        term('T1', 23, [
          partial('Avaliação 1', 8, 10),
          partial('Avaliação 2', 7.5, 10),
          partial('Redação: texto dissertativo', 3, 4),
          partial('Leitura dirigida', 2.5, 3),
          partial('Participação em sala', 2, 3),
        ]),
        term('T2', 14.5, [
          partial('Avaliação 1', 6, 10),
          partial('Avaliação 2', 4, 10),
          partial('Seminário: Modernismo brasileiro', 2, 4),
          notDone('Resenha crítica'),
          partial('Participação em sala', 2.5, 3),
        ]),
        ongoingT3([partial('Redação: artigo de opinião', 3, 4)]),
        recovery('REC2'),
      ],
    },
    {
      subjectId: 900003,
      label: 'Ciências',
      order: 3,
      periods: [
        term('T1', 27, [
          partial('Avaliação 1', 9, 10),
          partial('Avaliação 2', 8.5, 10),
          partial('Relatório de laboratório', 4, 4),
          partial('Maquete: célula animal', 2.5, 3),
          partial('Participação em sala', 3, 3),
        ]),
        term('T2', 17, [
          partial('Avaliação 1', 5.5, 10),
          partial('Avaliação 2', 6.5, 10),
          partial('Relatório de laboratório', 3, 4),
          partial('Quiz: tabela periódica', 0, 3),
          partial('Participação em sala', 2, 3),
        ]),
        ongoingT3([partial('Avaliação 1', 9, 15)]),
        recovery('REC2', 21),
      ],
    },
    {
      subjectId: 900004,
      label: 'História',
      order: 4,
      periods: [
        term('T1', 11.5, [
          partial('Avaliação 1', 3.5, 10),
          partial('Avaliação 2', 5, 10),
          partial('Linha do tempo: Brasil Colônia', 2, 4),
          notDone('Fichamento de texto'),
          partial('Participação em sala', 1, 3),
        ]),
        term('T2', 19, [
          partial('Avaliação 1', 6, 10),
          partial('Avaliação 2', 6, 10),
          partial('Pesquisa: Revolução Industrial', 3, 4),
          partial('Debate em sala', 2, 3),
          partial('Participação em sala', 2, 3),
        ]),
        ongoingT3([notDone('Atividade 1')]),
        recovery('REC1', 16),
      ],
    },
    {
      subjectId: 900005,
      label: 'Geografia',
      order: 5,
      periods: [
        term('T1', 20, [
          partial('Avaliação 1', 7, 10),
          partial('Avaliação 2', 6, 10),
          partial('Mapa: relevo brasileiro', 3, 4),
          partial('Estudo de caso', 2, 3),
          partial('Participação em sala', 2, 3),
        ]),
        term('T2', 10, [
          partial('Avaliação 1', 4, 10),
          partial('Avaliação 2', 3.5, 10),
          partial('Mapa temático', 1, 4),
          partial('Atividade de campo', 0, 3),
          partial('Participação em sala', 1.5, 3),
        ]),
        ongoingT3([partial('Avaliação 1', 12, 15)]),
        recovery('REC2'),
      ],
    },
    {
      subjectId: 900006,
      label: 'Inglês',
      order: 6,
      periods: [
        term('T1', 28, [
          partial('Avaliação 1', 9.5, 10),
          partial('Avaliação 2', 9, 10),
          partial('Listening', 3, 3),
          partial('Speaking', 3.5, 4),
          partial('Participação em sala', 3, 3),
        ]),
        term('T2', 24, [
          partial('Avaliação 1', 8, 10),
          partial('Avaliação 2', 8.5, 10),
          partial('Vocabulary quiz', 2, 3),
          partial('Writing', 3, 4),
          partial('Participação em sala', 2.5, 3),
        ]),
        ongoingT3([partial('Avaliação 1', 13, 15), partial('Listening', 2, 3)]),
      ],
    },
  ],
});

/*
 * Production-shaped scenario (checked against the scoped v2 editions served in 2026-09).
 * Marks and names are invented; only the structure and catalog mirror production:
 * - Fundamental II classes (6º–9º ANO) with the 12 real subjects, upper-case, in the real order;
 * - only T1 is published; term maximum 30 = AV1 8,5 + AV2 5 + JOGOS 3 + PARTICIPAÇÃO 4,5 + activities;
 * - T1 AV1/AV2 carry the school's configured names (1ª AVALIAÇÃO, SIMULADO);
 * - 6–9 activities per subject with the teachers' own upper-case, abbreviated labels;
 * - "Prova paralela" (graded out of AV1+AV2, 13,5) appears only when eligible (BN-DEC-035: AV1+AV2 and the total
 *   before it both below 60%) or already scored; a higher score replaces AV1+AV2 in the final;
 * - a few scores have no maximum (meetsMinimum null), and a few are zero.
 */
type RealActivityV1 = readonly [label: string, maximum: number | null, value: number | null];
const realSubject = (
  subjectId: number,
  label: string,
  order: number,
  activities: readonly RealActivityV1[],
) => {
  const partials = activities.map(([activity, maximum, value]) => ({
    assessmentId: ++nextAssessmentId,
    label: activity,
    mark:
      value === null
        ? absent
        : maximum === null
          ? { kind: 'score' as const, value, maximum: null, meetsMinimum: null }
          : score(value, maximum),
    // A blank activity is an observed "não fez" (D1); a pending parallel exam is not.
    ...(value === null && activity !== PARALLEL_LABEL ? { notDone: true as const } : {}),
    ...(activity === PARALLEL_LABEL ? { parallel: true as const } : {}),
    ...(activity === AV1_LABEL || activity === AV2_LABEL ? { assessment: true as const } : {}),
  }));
  const valueOf = (name: string) => activities.find(([activity]) => activity === name)?.[2] ?? null;
  const quantitative = (valueOf(AV1_LABEL) ?? 0) + (valueOf(AV2_LABEL) ?? 0);
  const parallel = valueOf(PARALLEL_LABEL);
  const beforeParallel = activities.reduce(
    (sum, [activity, , value]) => (activity === PARALLEL_LABEL ? sum : sum + (value ?? 0)),
    0,
  );
  const final = parallel !== null && parallel > quantitative ? beforeParallel - quantitative + parallel : beforeParallel;
  return { subjectId, label, order, periods: [{ period: 'T1' as const, final: score(final, 30), partials }] };
};
const AV1_LABEL = '1ª AVALIAÇÃO';
const AV2_LABEL = 'SIMULADO';
const PARALLEL_LABEL = 'Prova paralela';
/*
 * "Casos de tendência": one subject per case of the 2º-vs-1º trimester line (owner review
 * 27/09/2026). Max 30 and minimum 18 (60%): blue from 18, amber below.
 */
const TREND_CASES_V1: readonly [label: string, t1: number, t2: number][] = [
  ['1 AZUL QUE SUBIU', 20, 24],
  ['2 AZUL QUE CAIU', 27, 21],
  ['3 AZUL IGUAL', 22, 22],
  ['4 AZUL QUE VIROU ÂMBAR', 22, 15],
  ['5 ÂMBAR QUE CAIU MUITO', 16, 12],
  ['5B ÂMBAR QUE CAIU POUCO', 16, 15],
  ['6 ÂMBAR QUE SUBIU', 10, 15],
  ['7 ÂMBAR IGUAL', 14, 14],
  ['8 ÂMBAR QUE VIROU AZUL', 15, 20],
  ['9 BRILHANTE', 26, 29],
];
let trendDataV1: typeof previewData | undefined;
const trendPreviewData = () =>
  (trendDataV1 ??= selfResponseV1.parse({
    ...previewData,
    subjects: TREND_CASES_V1.map(([label, t1, t2], order) => ({
      subjectId: 930001 + order,
      label,
      order,
      periods: [
        term('T1', t1, [partial('Avaliação 1', Math.round((t1 / 3) * 2) / 2, 10), partial('Participação', 3, 3)]),
        term('T2', t2, [partial('Avaliação 1', Math.round((t2 / 3) * 2) / 2, 10), partial('Participação', 3, 3)]),
      ],
    })),
  }));
/*
 * "Como na produção": PORTUGUÊS and HISTÓRIA are red in the 1º trimestre, so ED. FÍSICA (29,5)
 * earns no seal (owner decision 27/09/2026). The panel can simulate the teachers correcting both
 * marks above the minimum, the only way the seal appears.
 */
const REAL_CORRECTED_T1_V1: Record<number, number> = { 910001: 19, 910003: 18.5 };
const withRealCorrectionV1 = (data: typeof previewData, corrected: boolean) =>
  corrected
    ? {
        ...data,
        subjects: data.subjects.map((subject) =>
          subject.subjectId in REAL_CORRECTED_T1_V1
            ? {
                ...subject,
                periods: subject.periods.map((period) =>
                  period.period === 'T1'
                    ? { ...period, final: score(REAL_CORRECTED_T1_V1[subject.subjectId]!, 30) }
                    : period,
                ),
              }
            : subject,
        ),
      }
    : data;
/*
 * "Vitrine" (owner request 28/09/2026): the Brilhante situations and the trend cases in one place,
 * the preview's default. The 1º trimestre has no red mark, so its two Brilhantes (MATEMÁTICA,
 * INGLÊS) earn seals; the 2º has reds, so MATEMÁTICA is Brilhante again but earns no seal. Each
 * activity set adds up to its trimester mark: Avaliação 1 and 2 of 10, Trabalho of 4, Lista of 3,
 * Participação of 3.
 */
type ShowcaseTermV1 = readonly [av1: number, av2: number, work: number, list: number, class_: number];
const showcaseTerm = (period: 'T1' | 'T2', [av1, av2, work, list, class_]: ShowcaseTermV1) =>
  term(period, av1 + av2 + work + list + class_, [
    partial('Avaliação 1', av1, 10),
    partial('Avaliação 2', av2, 10),
    partial('TRABALHO EM GRUPO', work, 4),
    partial('LISTA DE EXERCÍCIOS', list, 3),
    partial('PARTICIPAÇÃO', class_, 3),
  ]);
const SHOWCASE_CASES_V1: readonly [
  label: string,
  t1: ShowcaseTermV1,
  t2: ShowcaseTermV1,
  t3: ShowcaseTermV1,
][] = [
  // Brilhante in all three; the 2º has reds elsewhere, so only the 1º and 3º earn a seal. Subiu.
  ['MATEMÁTICA', [10, 9.5, 4, 3, 2.5], [10, 10, 4, 3, 2.5], [15, 14, 4, 3, 2.5]],
  // Brilhante (seal) in the 1º, Excelente in the 2º: "Porém caiu"; Excelente again in the 3º.
  ['INGLÊS', [9.5, 9.5, 4, 3, 2.5], [8, 8.5, 3.5, 2.5, 2.5], [13, 13, 3.5, 2.5, 2.5]],
  // Foi bem → Excelente: "Subiu"; holds Excelente in the 3º.
  ['PORTUGUÊS', [7, 7, 3, 2, 2], [8, 8, 3, 2.5, 2.5], [12, 12, 3, 2.5, 2.5]],
  // Foi bem → Não foi muito bem: "Caiu consideravelmente"; back just above the minimum (24) in the 3º.
  ['HISTÓRIA', [7.5, 7, 3, 2.5, 2], [4.5, 4, 2, 1.5, 2], [10, 9, 2.5, 2, 2]],
  // Foi bem → Precisa melhorar: "Caiu consideravelmente"; recovers in the 3º.
  ['CIÊNCIAS', [6, 6, 3, 2, 2], [3, 2.5, 1, 1, 2], [11, 10, 3, 2, 2]],
  // Same mark: "Se manteve igual".
  ['ARTE', [6.5, 6.5, 3, 2, 2], [6.5, 6.5, 3, 2, 2], [10, 10, 3, 2, 2]],
  // Right at the minimum (18,0), then up; exactly the 3º minimum (24,0).
  ['GEOGRAFIA', [6, 5.5, 2.5, 2, 2], [6.5, 6, 3, 2, 2], [9, 9, 2.5, 1.5, 2]],
];
/*
 * 3º trimestre in the Vitrine (owner request 20/10/2026), chosen in "Simular admin": not started
 * (no tab), in progress (activities so far, no trimester mark) or closed (mark of 40, minimum 24).
 */
type ThirdTermStateV1 = 'hidden' | 'ongoing' | 'closed';
const showcaseThirdTerm = (state: ThirdTermStateV1, [av1, av2, work, list, class_]: ShowcaseTermV1) =>
  state === 'closed'
    ? {
        period: 'T3' as const,
        final: score(av1 + av2 + work + list + class_, TERM_MAXIMUM.T3),
        partials: [
          partial('Avaliação 1', av1, 15),
          partial('Avaliação 2', av2, 15),
          partial('TRABALHO EM GRUPO', work, 4),
          partial('LISTA DE EXERCÍCIOS', list, 3),
          partial('PARTICIPAÇÃO', class_, 3),
        ],
      }
    : ongoingT3([partial('Avaliação 1', av1, 15), partial('TRABALHO EM GRUPO', work, 4)]);
const showcaseDataV1 = new Map<ThirdTermStateV1, typeof previewData>();
const showcasePreviewData = (thirdTerm: ThirdTermStateV1) => {
  const cached = showcaseDataV1.get(thirdTerm);
  if (cached) return cached;
  const data = selfResponseV1.parse({
    ...previewData,
    // 1º and 2º trimesters are over in every scenario, so their seals never depend on the 3º;
    // a closed 3º trimester ends the year's terms and its seals count like the others.
    ...(thirdTerm === 'closed'
      ? { generatedAt: '2026-12-10T12:00:00-03:00', endedPeriods: ['T1', 'T2', 'T3'] }
      : { endedPeriods: ['T1', 'T2'] }),
    subjects: SHOWCASE_CASES_V1.map(([label, t1, t2, t3], order) => ({
      subjectId: 940001 + order,
      label,
      order,
      periods: [
        showcaseTerm('T1', t1),
        showcaseTerm('T2', t2),
        ...(thirdTerm === 'hidden' ? [] : [showcaseThirdTerm(thirdTerm, t3)]),
      ],
    })),
  });
  showcaseDataV1.set(thirdTerm, data);
  return data;
};
/*
 * "Recuperação nos 3 trimestres" (owner request 20/10/2026): MATEMÁTICA falls below the minimum
 * in the 1º, 2º and 3º trimestres and takes REC1, REC2 and REC3, each scored against its
 * trimester maximum (30/30/40). The other subjects pass every trimester, so only one row carries
 * recoveries. All three trimesters are closed, as at the end of the year.
 */
const half = (value: number) => Math.round(value * 2) / 2;
// Two assessments (10/10, or 15/15 in the 3º) and participation (10) adding up to the term mark.
const recoveryTerm = (period: 'T1' | 'T2' | 'T3', final: number) => {
  const assessment = half(final * 0.4);
  const maximum = period === 'T3' ? 15 : 10;
  return {
    period,
    final: score(final, TERM_MAXIMUM[period]),
    partials: [
      partial('Avaliação 1', assessment, maximum),
      partial('Avaliação 2', assessment, maximum),
      partial('Participação em sala', final - 2 * assessment, 10),
    ],
  };
};
const recoveryScore = (period: 'REC1' | 'REC2' | 'REC3', value: number) => ({
  period,
  final: score(value, TERM_MAXIMUM[period === 'REC1' ? 'T1' : period === 'REC2' ? 'T2' : 'T3']),
});
const RECOVERY_CASES_V1: readonly [label: string, t1: number, t2: number, t3: number][] = [
  ['MATEMÁTICA', 12, 14.5, 18],
  ['PORTUGUÊS', 21, 22.5, 30],
  ['CIÊNCIAS', 24, 20, 31],
  ['HISTÓRIA', 19, 23, 28],
  ['GEOGRAFIA', 22, 21.5, 29.5],
];
let recoveryDataV1: typeof previewData | undefined;
const recoveryPreviewData = () =>
  (recoveryDataV1 ??= selfResponseV1.parse({
    ...previewData,
    generatedAt: '2026-12-10T12:00:00-03:00',
    subjects: RECOVERY_CASES_V1.map(([label, t1, t2, t3], order) => ({
      subjectId: 950001 + order,
      label,
      order,
      periods: [
        recoveryTerm('T1', t1),
        recoveryTerm('T2', t2),
        recoveryTerm('T3', t3),
        ...(order === 0
          ? [recoveryScore('REC1', 19.5), recoveryScore('REC2', 18), recoveryScore('REC3', 26)]
          : []),
      ],
    })),
  }));
const realPreviewData = selfResponseV1.parse({
  ...previewData,
  profile: { ...previewData.profile, classLabel: '7º ANO B' },
  subjects: [
    realSubject(910001, 'PORTUGUÊS', 0, [
      [AV1_LABEL, 8.5, 4],
      [AV2_LABEL, 5, 2.5],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 3],
      ['1ª ATIVIDADE AVALIATIVA', 6, null],
      ['PRODUÇÃO DE TEXTO', 3, 1.5],
      [PARALLEL_LABEL, 13.5, null],
    ]),
    realSubject(910002, 'MATEMÁTICA', 1, [
      [AV1_LABEL, 8.5, 7.5],
      [AV2_LABEL, 5, 4],
      ['JOGOS', 3, 3],
      ['PART', 4.5, 4.5],
      ['I ATIV', 6, 5],
      ['II ATIV', 3, 2.5],
    ]),
    realSubject(910003, 'HISTÓRIA', 2, [
      [AV1_LABEL, 8.5, 3],
      [AV2_LABEL, 5, 2],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 2],
      ['1ª ATIVIDADE', 6, 3],
      ['2ª ATIVIDADE', 3, 0],
      [PARALLEL_LABEL, 13.5, 7],
    ]),
    realSubject(910004, 'GEOGRAFIA', 3, [
      [AV1_LABEL, 8.5, 6],
      [AV2_LABEL, 5, 3.5],
      ['JOGOS', 3, 3],
      ['PARTI', 4.5, 4],
      ['CAED', 6, 4.5],
      ['MAPA-MENTAL', 3, 2],
    ]),
    realSubject(910005, 'CIÊNCIAS', 4, [
      [AV1_LABEL, 8.5, 8],
      [AV2_LABEL, 5, 4.5],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 4],
      ['ATIVIDADE INVESTIGATIVA', 6, 5.5],
      ['LAPBOOK', 3, 3],
    ]),
    realSubject(910006, 'ARTE', 5, [
      [AV1_LABEL, 8.5, 5],
      [AV2_LABEL, 5, 3],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 3.5],
      ['RELEITURA - ABAPORU (INDIVIDUAL)', 3, 2.5],
      ['CARTAZ (MPB, BOSSA NOVA E ROCK)', 3, 2],
      ['VÍDEO HOMENAGEM MEDEIROS NETO', 3, null],
      ['P.D.', null, 1],
    ]),
    realSubject(910007, 'RELIGIÃO', 6, [
      [AV1_LABEL, 8.5, 7],
      [AV2_LABEL, 5, 4],
      ['JOGOS', 3, 3],
      ['PRT', 4.5, 4],
      ['LÍDERES RELIGIOSOS', 3, 3],
      ['LIVROS SAGRADOS', 6, 5],
    ]),
    realSubject(910008, 'REDAÇÃO', 7, [
      [AV1_LABEL, 8.5, 6.5],
      [AV2_LABEL, 5, 3],
      ['JOGOS', 3, 3],
      ['PARTIC.', 4.5, 3.5],
      ['PRODUÇÃO DE TEXTO', 6, 4],
      ['2ª ATIVIDADE', 3, 2],
    ]),
    realSubject(910009, 'ED. FÍSICA', 8, [
      [AV1_LABEL, 8.5, 8.5],
      [AV2_LABEL, 5, 5],
      ['Jogos interclasse', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 4.5],
      ['GINCANA', 6, 6],
      ['PESQUISA', 3, 2.5],
    ]),
    realSubject(910010, 'ÉTICA', 9, [
      [AV1_LABEL, 8.5, 7],
      [AV2_LABEL, 5, 4.5],
      ['JOGOS', 3, 3],
      ['PART', 4.5, 4],
      ['ÁRVORE DE VALORES', 6, 5],
      ['2ª PARTICIPAÇÃO', 3, 2.5],
    ]),
    realSubject(910011, 'INGLÊS', 10, [
      [AV1_LABEL, 8.5, 7.5],
      [AV2_LABEL, 5, 4],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 4],
      ['1ª ATIV', 6, 5],
      ['2ª ATIV', 3, 3],
    ]),
    realSubject(910012, 'COMPUTAÇÃO', 11, [
      [AV1_LABEL, 8.5, 6],
      [AV2_LABEL, 5, 4],
      ['JOGOS', 3, 3],
      ['PARTICIPAÇÃO', 4.5, 4.5],
      ['A. COMP.', 6, 5],
      ['TRAB', 3, 3],
    ]),
  ],
});

/*
 * Fechamento do trimestre (#1132), preview only. The browser bundle may not import the server
 * engine, so these are the codes that engine produces for the production-shaped T1 above
 * (attention: PORTUGUÊS with a blank, HISTÓRIA with the parallel exam; point: ARTE; the rest good),
 * with variants spread as the server would (no repeated line on one page).
 */
type ClosingV1 = NonNullable<SelfResponseV1['subjects'][number]['closings']>[number];
const goodLine = (variant: number, period: ClosingV1['period'] = 'T1'): ClosingV1 => ({
  period,
  mode: 'conclusion',
  level: 'good',
  conclusion: { code: 'line.good', variant },
});
/** Same reading as "Acompanhamento" (policy termClosingConclusive off): present-tense codes. */
function asProgressV1(closing: ClosingV1): ClosingV1 {
  const code = (value: string) =>
    value
      .replace('conclusion.good-with-point', 'conclusion.point')
      .replace(/^(conclusion|weight|strength|action|line)\./u, 'progress.$1.');
  const message = (value?: ClosingV1['conclusion']) =>
    value ? { ...value, code: code(value.code) as ClosingV1['conclusion']['code'] } : undefined;
  return selfResponseV1.shape.subjects.element.shape.closings.unwrap().element.parse({
    ...closing,
    mode: 'progress',
    conclusion: message(closing.conclusion),
    ...(closing.weight ? { weight: message(closing.weight) } : {}),
    ...(closing.strength ? { strength: message(closing.strength) } : {}),
    ...(closing.action ? { action: message(closing.action) } : {}),
  });
}
const REAL_CLOSINGS_V1: Record<number, ClosingV1> = {
  910001: {
    period: 'T1',
    mode: 'conclusion',
    level: 'attention',
    conclusion: { code: 'conclusion.attention', variant: 1 },
    weight: { code: 'weight.not-done', variant: 1 },
    action: { code: 'action.catch-up', variant: 0 },
  },
  910003: {
    period: 'T1',
    mode: 'conclusion',
    level: 'attention',
    conclusion: { code: 'conclusion.attention', variant: 0 },
    weight: { code: 'weight.assessments', variant: 0 },
    strength: { code: 'strength.parallel-done', variant: 1 },
    action: { code: 'action.assessments', variant: 2 },
  },
  910006: {
    period: 'T1',
    mode: 'conclusion',
    level: 'point',
    conclusion: { code: 'conclusion.good-with-point', variant: 2 },
    weight: { code: 'weight.assessments', variant: 1 },
    strength: { code: 'strength.activities', variant: 0 },
    action: { code: 'action.assessments', variant: 0 },
  },
  910002: goodLine(0),
  910004: goodLine(1),
  910005: goodLine(2),
  910007: goodLine(3),
  910008: goodLine(4),
  910009: goodLine(5),
  910010: goodLine(0),
  910011: goodLine(1),
  910012: goodLine(2),
};

/*
 * "Exemplo completo": a closing for each closed trimester (T1 and T2) of every subject, chosen to
 * match the invented marks above (below the minimum = attention, just above or with a blank =
 * point, clearly above = one line), so every discipline shows its report.
 */
const reading = (
  period: ClosingV1['period'],
  level: 'attention' | 'point',
  variant: number,
  weight: string,
  action: string,
  strength?: string,
): ClosingV1 =>
  selfResponseV1.shape.subjects.element.shape.closings.unwrap().element.parse({
    period,
    mode: 'conclusion',
    level,
    conclusion: { code: level === 'attention' ? 'conclusion.attention' : 'conclusion.good-with-point', variant },
    weight: { code: weight, variant },
    ...(strength ? { strength: { code: strength, variant } } : {}),
    action: { code: action, variant },
  });
const EXAMPLE_CLOSINGS_V1: Record<number, ClosingV1[]> = {
  900001: [
    reading('T1', 'attention', 0, 'weight.assessments', 'action.assessments', 'strength.activities'),
    reading('T2', 'point', 1, 'weight.not-done', 'action.catch-up', 'strength.assessments'),
  ],
  900002: [goodLine(0), reading('T2', 'attention', 2, 'weight.not-done', 'action.catch-up', 'strength.activities')],
  900003: [goodLine(1), reading('T2', 'attention', 1, 'weight.assessments', 'action.assessments')],
  900004: [
    reading('T1', 'attention', 2, 'weight.not-done', 'action.catch-up'),
    reading('T2', 'point', 0, 'weight.assessments', 'action.assessments', 'strength.all-done'),
  ],
  900005: [
    reading('T1', 'point', 2, 'weight.activities', 'action.keep', 'strength.assessments'),
    reading('T2', 'attention', 0, 'weight.assessments', 'action.assessments'),
  ],
  900006: [goodLine(2), goodLine(0, 'T2')],
};

/*
 * Admin simulator (preview only). The browser bundle may not import server code, so this
 * restates server/student-portal/policies/calendar-v1.ts#applyPublishedVisibilityV1 over the
 * invented data: unreleased periods are dropped, partials are removed when showPartials is off,
 * EM RECUPERAÇÃO follows the T3 release and every other situation/outcome waits for the final
 * disclosure. Keep both in sync if the rule changes.
 */
type PeriodIdV1 = SelfResponseV1['subjects'][number]['periods'][number]['period'];
type AnnualSituationV1 = NonNullable<SelfResponseV1['profile']['annualSituation']>;
type SubjectSituationV1 = NonNullable<SelfResponseV1['subjects'][number]['annualSituation']>;
interface AdminSimulationV1 {
  accessEnabled: boolean;
  showPartials: boolean;
  /** Policy `showTermClosing` (#1132); the preview treats T1 as already closed. */
  showTermClosing: boolean;
  /** Policy `termClosingConclusive`: off shows the same T1 as a trimester in progress. */
  termClosingConclusive: boolean;
  /** Policy `showFrequency`: off hides the attendance section, as in production. */
  showFrequency: boolean;
  /** Policy `showSchedule` (owner decision 22/10/2026): off hides the "Horário" page. */
  showSchedule: boolean;
  /** The sentence about the absences on Frequência: computed from the invented data, or forced. */
  frequencyComment: DemoCommentChoiceV3;
  periods: readonly PeriodIdV1[];
  finalDisclosed: boolean;
  /** Approved background-free portrait exists (none in production yet). */
  hasPortrait: boolean;
  studentName: string;
  situation: AnnualSituationV1 | 'none';
  dataset: 'showcase' | 'real' | 'example' | 'trend' | 'recovery';
  academicState: SelfResponseV1['profile']['academicState'];
  /** 3º trimestre of the Vitrine: not started, in progress or closed. */
  thirdTerm: ThirdTermStateV1;
  /** Two real students have a single published subject. */
  singleSubject: boolean;
  /** Portal notices (/api/student/status): release countdown or grades hidden again. */
  notice: 'none' | 'countdown' | 'ended';
  /** "Como na produção": teachers corrected the two red T1 marks, so ED. FÍSICA earns its seal. */
  correctedRed: boolean;
}
// Short (regular), long and extra-long names exercise the hero's type-size tiers. Production
// names are all upper-case, 20–39 characters, 3–6 words; the first one mirrors that.
const PREVIEW_NAMES_V1 = [
  'ALUNO ARTIFICIAL',
  'ANA CAROLINA DE JESUS SANTOS OLIVEIRA',
  'Pedro Henrique Almeida',
  'MARIA LUIZA FERREIRA XAVIER',
  'MARIA EDUARDA DOS SANTOS FERREIRA DA SILVA XAVIER',
  'ÂNGELA GONÇALVES DE ÁVILA JOÃO',
] as const;
const ALL_PERIODS_V1: readonly PeriodIdV1[] = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'];
const SITUATION_OPTIONS_V1: readonly [AdminSimulationV1['situation'], string][] = [
  ['none', 'Em curso'],
  ['in-recovery', 'Em recuperação'],
  ['approved-direct', 'Aprovado direto'],
  ['approved-after-recovery', 'Aprovado pela recuperação'],
  ['approved-by-council', 'Aprovado pelo Conselho'],
  ['approved-special', 'Aprovado (especial)'],
  ['failed-after-recovery', 'Reprovado após recuperação'],
  ['failed-no-show', 'Reprovado por não comparecimento'],
  ['failed-repeat', 'Reprovado (R/R)'],
  ['failed-by-council', 'Reprovado pelo Conselho'],
  ['failed-by-absence', 'Reprovado por falta'],
];

// Invented per-subject classifications consistent with each annual situation. Língua
// Portuguesa and Geografia are the subjects that went to recovery in the sample data.
function subjectSituationFor(
  situation: AdminSimulationV1['situation'],
  label: string,
): SubjectSituationV1 | undefined {
  const key = label.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();
  const recovered = key.includes('portugues') || key === 'geografia';
  switch (situation) {
    case 'none':
    case 'approved-special':
      return undefined;
    case 'in-recovery':
      return recovered ? 'recovery-pending' : 'approved-direct';
    case 'approved-direct':
      return 'approved-direct';
    case 'approved-after-recovery':
      return recovered ? 'approved-after-recovery' : 'approved-direct';
    case 'failed-after-recovery':
      return recovered || key === 'historia' ? 'not-approved' : 'approved-direct';
    case 'failed-no-show':
      return key === 'geografia' ? 'failed-no-show' : recovered ? 'approved-after-recovery' : 'approved-direct';
    case 'failed-repeat':
      return key === 'geografia' ? 'failed-repeat' : recovered ? 'approved-after-recovery' : 'approved-direct';
    default: // Council cases: one subject failed within the Council limit.
      return key === 'geografia' ? 'not-approved' : recovered ? 'approved-after-recovery' : 'approved-direct';
  }
}
const coarseResultV1 = (situation: AdminSimulationV1['situation']): SelfResponseV1['profile']['result'] =>
  situation === 'none' || situation === 'in-recovery'
    ? 'in-progress'
    : situation === 'failed-by-absence'
      ? 'failed-attendance'
      : situation.startsWith('approved')
        ? 'approved'
        : 'failed';

function simulateAdminV1(data: SelfResponseV1, admin: AdminSimulationV1): SelfResponseV1 {
  const final = admin.finalDisclosed && admin.accessEnabled;
  const recoveryDisclosed = admin.accessEnabled && admin.periods.includes('T3');
  const visible = (value: string | undefined, early: string) =>
    value !== undefined && (final || (recoveryDisclosed && value === early));
  const assisted = admin.academicState === 'assisted';
  const situation = admin.situation === 'none' || assisted ? undefined : admin.situation;
  const subjects = admin.accessEnabled
    ? data.subjects
        .slice(0, admin.singleSubject ? 1 : undefined)
        .map((subject) => {
          const subjectSituation = subjectSituationFor(admin.situation, subject.label);
          const outcome =
            subjectSituation === 'approved-direct' || subjectSituation === 'approved-after-recovery'
              ? ('approved' as const)
              : subjectSituation && subjectSituation !== 'recovery-pending'
                ? ('failed' as const)
                : undefined;
          return {
            subjectId: subject.subjectId,
            label: subject.label,
            order: subject.order,
            ...(final && outcome ? { officialOutcome: outcome } : {}),
            ...(visible(subjectSituation, 'recovery-pending')
              ? { annualSituation: subjectSituation }
              : {}),
            periods: subject.periods
              .filter((period) => admin.periods.includes(period.period))
              .map(({ partials, ...period }) =>
                admin.showPartials && partials !== undefined ? { ...period, partials } : period,
              ),
          };
        })
        .filter((subject) => subject.periods.length > 0)
    : [];
  // Closings follow the policy, access and a regular student (D8, D9); a closed but unreleased
  // T1 keeps its subject with only the closing (R2).
  const closingsOn = admin.accessEnabled && admin.showTermClosing && admin.academicState === 'regular';
  const closingsOf = (subjectId: number): ClosingV1[] | undefined =>
    admin.dataset === 'real'
      ? REAL_CLOSINGS_V1[subjectId] && [REAL_CLOSINGS_V1[subjectId]]
      : EXAMPLE_CLOSINGS_V1[subjectId];
  // A closing shows together with its trimester's released marks, never alone (owner, 2026-09-24).
  const withClosings: SelfResponseV1['subjects'] = closingsOn
    ? subjects.map((subject): SelfResponseV1['subjects'][number] => {
        const released = closingsOf(subject.subjectId)?.filter((closing) =>
          subject.periods.some((period) => period.period === closing.period),
        );
        return released?.length
          ? { ...subject, closings: released.map((closing) => (admin.termClosingConclusive ? closing : asProgressV1(closing))) }
          : (subject as SelfResponseV1['subjects'][number]);
      })
    : subjects;
  // One Boletim summary per closed trimester, as the server sends them (closingSummaries).
  const summaryPeriods = (admin.dataset === 'real' ? ['T1'] : ['T1', 'T2']).filter((period) =>
    withClosings.some((subject) => subject.closings?.some((closing) => closing.period === period)),
  ) as ClosingV1['period'][];
  const summaries = summaryPeriods.map((period) => {
    const attention = withClosings.filter(
      (subject) => subject.closings?.find((closing) => closing.period === period)?.level === 'attention',
    );
    return {
      period,
      mode: admin.termClosingConclusive ? ('conclusion' as const) : ('progress' as const),
      message: {
        code: `${admin.termClosingConclusive ? '' : 'progress.'}${attention.length ? 'summary.few-attention' : 'summary.all-good'}`,
        variant: 0,
      },
      attentionSubjectIds: attention.map((subject) => subject.subjectId),
    };
  });
  return selfResponseV1.parse({
    ...data,
    state: withClosings.length > 0 ? 'ready' : 'no-publication',
    ...(closingsOn && withClosings.some((subject) => subject.closings)
      ? { closingSummary: summaries.at(-1), closingSummaries: summaries }
      : {}),
    profile: {
      ...data.profile,
      name: admin.studentName,
      ...(admin.studentName === 'ALUNO ARTIFICIAL' ? { classLabel: 'TURMA ARTIFICIAL' } : {}),
      academicState: admin.academicState,
      result: assisted ? 'not-applicable' : final ? coarseResultV1(admin.situation) : 'in-progress',
      ...(visible(situation, 'in-recovery') ? { annualSituation: situation } : {}),
    },
    subjects: withClosings,
    showFrequency: admin.showFrequency,
    showSchedule: admin.showSchedule,
  });
}

/** Invented attendance and weekly grid (the redesign's demo clients): no request leaves the page. */
const demoScheduleClient = createDemoScheduleClientV3();

const panelStyle: CSSProperties = {
  position: 'fixed',
  bottom: 88,
  left: 8,
  zIndex: 200,
  maxWidth: 'calc(100vw - 16px)',
  padding: '8px 12px',
  borderRadius: 14,
  background: 'rgb(15 23 42 / 0.92)',
  color: 'white',
  font: '12px/1.4 system-ui, sans-serif',
  boxShadow: '0 10px 30px rgb(0 0 0 / 0.3)',
};
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', margin: '6px 0' };

function AdminSimulatorPanelV1({
  value,
  onChange,
}: {
  value: AdminSimulationV1;
  onChange: (next: AdminSimulationV1) => void;
}) {
  const toggle = (key: 'accessEnabled' | 'showPartials' | 'showTermClosing' | 'termClosingConclusive' | 'showFrequency' | 'showSchedule' | 'finalDisclosed' | 'hasPortrait' | 'singleSubject' | 'correctedRed') => (
    <input type="checkbox" checked={value[key]} onChange={() => onChange({ ...value, [key]: !value[key] })} />
  );
  return (
    <details style={panelStyle}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Simular admin</summary>
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Dados:</span>
        <select
          value={value.dataset}
          onChange={(event) => onChange({ ...value, dataset: event.target.value as AdminSimulationV1['dataset'] })}
        >
          <option value="showcase">Vitrine: Brilhante e tendências</option>
          <option value="real">Como na produção (7º ANO, só T1)</option>
          <option value="example">Exemplo completo (T1–T3 e REC)</option>
          <option value="trend">Casos de tendência (2º vs 1º)</option>
          <option value="recovery">Recuperação nos 3 trimestres (MATEMÁTICA)</option>
        </select>
        <label>{toggle('singleSubject')} Só 1 disciplina</label>
      </div>
      {value.dataset === 'showcase' ? (
        <div style={rowStyle}>
          <span style={{ opacity: 0.7 }}>3º trimestre:</span>
          <select
            value={value.thirdTerm}
            onChange={(event) =>
              onChange({ ...value, thirdTerm: event.target.value as AdminSimulationV1['thirdTerm'] })
            }
          >
            <option value="hidden">Não iniciado</option>
            <option value="ongoing">Em andamento (sem nota final)</option>
            <option value="closed">Encerrado (nota final)</option>
          </select>
        </div>
      ) : null}
      {value.dataset === 'real' ? (
        <div style={rowStyle}>
          <label>
            {toggle('correctedRed')} Professores corrigiram PORTUGUÊS e HISTÓRIA (sem vermelhas no 1º tri)
          </label>
        </div>
      ) : null}
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Aviso:</span>
        <select
          value={value.notice}
          onChange={(event) => onChange({ ...value, notice: event.target.value as AdminSimulationV1['notice'] })}
        >
          <option value="none">Nenhum</option>
          <option value="countdown">Contagem para liberar notas</option>
          <option value="ended">Lançamento de notas encerrado</option>
        </select>
      </div>
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Aluno:</span>
        <select
          value={value.academicState}
          onChange={(event) =>
            onChange({ ...value, academicState: event.target.value as AdminSimulationV1['academicState'] })
          }
        >
          <option value="regular">Regular</option>
          <option value="assisted">Assistido</option>
          <option value="special">Especial</option>
        </select>
      </div>
      <div style={rowStyle}>
        <label>{toggle('accessEnabled')} Acesso liberado</label>
        <label>{toggle('showPartials')} Mostrar detalhamento</label>
        <label>{toggle('showTermClosing')} Relatório do trimestre</label>
        <label>{toggle('termClosingConclusive')} Usar termos de conclusão</label>
        <label>{toggle('showFrequency')} Frequência</label>
        <label>{toggle('showSchedule')} Horário</label>
        <label>
          Frase da frequência{' '}
          <select
            value={value.frequencyComment}
            onChange={(event) => onChange({ ...value, frequencyComment: event.target.value as DemoCommentChoiceV3 })}
          >
            <option value="auto">Automática</option>
            <option value="none">Nenhuma</option>
            {Object.entries(DEMO_FREQUENCY_COMMENTS_V3).map(([kind, item]) => (
              <option key={kind} value={kind}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>{toggle('hasPortrait')} Foto do aluno</label>
      </div>
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Períodos liberados:</span>
        {ALL_PERIODS_V1.map((period) => (
          <label key={period}>
            <input
              type="checkbox"
              checked={value.periods.includes(period)}
              onChange={() =>
                onChange({
                  ...value,
                  periods: value.periods.includes(period)
                    ? value.periods.filter((item) => item !== period)
                    : [...value.periods, period],
                })
              }
            />{' '}
            {period}
          </label>
        ))}
      </div>
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Nome:</span>
        <select
          value={value.studentName}
          onChange={(event) => onChange({ ...value, studentName: event.target.value })}
        >
          {PREVIEW_NAMES_V1.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={{ opacity: 0.7 }}>Situação oficial no BN:</span>
        <select
          value={value.situation}
          onChange={(event) =>
            onChange({ ...value, situation: event.target.value as AdminSimulationV1['situation'] })
          }
        >
          {SITUATION_OPTIONS_V1.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <label>{toggle('finalDisclosed')} Divulgar resultado final</label>
        <span style={{ opacity: 0.7 }}>(Em recuperação aparece com T3 liberado)</span>
      </div>
    </details>
  );
}

/** Portal with invented data and the admin simulator: the local preview and the ADM demo page. */
export function PortalDemoAppV1() {
  const [admin, setAdmin] = useState<AdminSimulationV1>({
    accessEnabled: true,
    showPartials: true,
    showTermClosing: true,
    termClosingConclusive: true,
    showFrequency: false,
    showSchedule: false,
    frequencyComment: 'auto',
    periods: ALL_PERIODS_V1,
    finalDisclosed: false,
    hasPortrait: true,
    studentName: PREVIEW_NAMES_V1[0]!,
    situation: 'none',
    dataset: 'showcase',
    thirdTerm: 'closed',
    academicState: 'regular',
    singleSubject: false,
    notice: 'none',
    correctedRed: false,
  });
  const data = useMemo(
    () =>
      simulateAdminV1(
        admin.dataset === 'real'
          ? withRealCorrectionV1(realPreviewData, admin.correctedRed)
          : admin.dataset === 'trend'
            ? trendPreviewData()
            : admin.dataset === 'recovery'
              ? recoveryPreviewData()
            : admin.dataset === 'showcase'
              ? showcasePreviewData(admin.thirdTerm)
            : previewData,
        admin.notice === 'countdown' ? { ...admin, periods: [] } : admin,
      ),
    [admin],
  );
  // A new client per choice, so the page reads the forced sentence again (keyed below).
  const frequencyClient = useMemo(() => createDemoFrequencyClientV3(admin.frequencyComment), [admin.frequencyComment]);
  const [releaseAt] = useState(() => new Date(Date.now() + (86400 + 4 * 3600 + 25 * 60) * 1000).toISOString());
  return (
    <>
      <AdminSimulatorPanelV1 value={admin} onChange={setAdmin} />
      <StudentPortalPageV1
        load={{ state: 'ready', data }}
        status={
          admin.notice === 'none' ? undefined : (
            <PortalSignedInNoticesV1
              key={admin.notice}
              hasGrades={data.state !== 'no-publication' && data.subjects.length > 0}
              notices={{
                access: 'open',
                accessOpensAt: null,
                gradesReleaseAt: admin.notice === 'countdown' ? releaseAt : null,
                disclosureEnded:
                  admin.notice === 'ended' ? { period: 'T1', at: '2026-09-20T18:00:00-03:00' } : null,
              }}
            />
          )
        }
        onLogout={() => undefined}
        portraitSrc={admin.hasPortrait ? previewPortrait : undefined}
        frequencyClient={frequencyClient}
        scheduleClient={demoScheduleClient}
      />
    </>
  );
}

