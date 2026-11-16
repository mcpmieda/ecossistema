import { SCHOOL_TIME_ZONE_V1 } from '../school-time-zone-v1';
import type { z } from 'zod';
import type { calendarV1 } from './policy-v1';
import type { SelfResponseV1 } from './self-v1';

// Invented examples; never generated from school records. Not runtime seed data.
export const SYNTHETIC_ID_V1 = '11111111-1111-4111-8111-111111111111';
export const SYNTHETIC_QR_V1 = `https://aluno.escolaieda.com/access#v1.${'a'.repeat(43)}.1.${'b'.repeat(43)}`;
export const EMPTY_CALENDAR_V1: z.infer<typeof calendarV1> = {
  timezone: SCHOOL_TIME_ZONE_V1,
  enrollmentStartsAt: null,
  yearStartsAt: null,
  t1EndsAt: null,
  t2StartsAt: null,
  t2EndsAt: null,
  t3StartsAt: null,
  t3EndsAt: null,
  recoveriesStartAt: null,
  yearEndsAt: null,
  finalDisclosureAt: null,
  disclosure: { mode: 'single', at: null, periods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] },
};
export const SYNTHETIC_SELF_V1: SelfResponseV1 = {
  contractVersion: 1,
  requestId: SYNTHETIC_ID_V1,
  state: 'ready',
  profile: {
    accountId: SYNTHETIC_ID_V1,
    link: { academicYear: 2026, studentId: 900001 },
    name: 'Estudante de exemplo',
    classLabel: 'Turma de exemplo',
    academicState: 'regular',
    result: 'in-progress',
  },
  revisions: {
    dataVersion: 'academic:1',
    policyVersion: 'policy:1',
    publicationVersion: 'publication:1',
  },
  generatedAt: '2026-09-01T12:00:00Z',
  subjects: [
    {
      subjectId: 900001,
      label: 'Disciplina de exemplo',
      order: 1,
      periods: [
        { period: 'T1', final: { kind: 'score', value: 0, maximum: 10, meetsMinimum: false } },
      ],
    },
  ],
};
