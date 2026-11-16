// @vitest-environment node
import { expect, it } from 'vitest';
import { academicSubjectSchemaV1 } from '../../../shared/gradebook-contracts/student-portal/academic-student-reader-v1';
import { subjectV1 } from '../../../shared/student-portal-contracts/self-v1';

const partials = (length: number) =>
  Array.from({ length }, (_, index) => ({
    assessmentId: index + 1,
    label: `SYNTHETIC ASSESSMENT ${index + 1}`,
    mark: { kind: 'absent' as const },
  }));
const subject = (length: number) => ({
  subjectId: 1,
  label: 'SYNTHETIC SUBJECT',
  order: 0,
  periods: [
    { period: 'T1' as const, final: { kind: 'absent' as const }, partials: partials(length) },
  ],
});
it.each([0, 12, 13])(
  'preserves all %s legitimate assessments in both sides of the academic boundary',
  (length) => {
    const academic = academicSubjectSchemaV1.parse({
      ...subject(length),
      officialAnnual: { kind: 'absent' },
    });
    const self = subjectV1.parse(subject(length));
    expect(academic.periods[0]?.partials).toHaveLength(length);
    expect(self.periods[0]?.partials).toHaveLength(length);
  },
);
it('rejects a fourteenth assessment instead of allowing unbounded input', () => {
  expect(
    academicSubjectSchemaV1.safeParse({ ...subject(14), officialAnnual: { kind: 'absent' } })
      .success,
  ).toBe(false);
  expect(subjectV1.safeParse(subject(14)).success).toBe(false);
});
