import { z } from 'zod';
import {
  academicVersionSchemaV1,
  portalAcademicLinkSchemaV1,
  type PortalAcademicLinkV1,
} from './academic-revision-v1';

export const enrollmentStatusSchemaV1 = z.union([
  z.null(),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export const academicBindingSchemaV1 = z
  .object({
    ...portalAcademicLinkSchemaV1.shape,
    classId: z.number().int().positive().safe(),
    status: enrollmentStatusSchemaV1,
  })
  .strict();
export const eligibilitySchemaV1 = z
  .object({
    contractVersion: z.literal(1),
    link: portalAcademicLinkSchemaV1,
    dataVersion: academicVersionSchemaV1,
    current: academicBindingSchemaV1.nullable(),
    state: z.enum(['eligible', 'exit', 'unresolved']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const current = value.current;
    if (
      current &&
      (current.studentId !== value.link.studentId ||
        current.academicYear !== value.link.academicYear ||
        current.status === 6)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid current binding', path: ['current'] });
    }
    let state: 'unresolved' | 'exit' | 'eligible';
    if (current === null) {
      state = 'unresolved';
    } else if ([3, 4, 5].includes(current.status ?? 0)) {
      state = 'exit';
    } else {
      state = 'eligible';
    }
    if (value.state !== state)
      ctx.addIssue({ code: 'custom', message: 'Inconsistent eligibility', path: ['state'] });
  });
export type EligibilityV1 = z.infer<typeof eligibilitySchemaV1>;

/** Select by stable year/id only; history (6) can never become current. */
export function resolveEligibilityV1(
  link: PortalAcademicLinkV1,
  dataVersion: string,
  bindings: readonly z.infer<typeof academicBindingSchemaV1>[],
): EligibilityV1 {
  portalAcademicLinkSchemaV1.parse(link);
  const candidates = bindings
    .map((item) => academicBindingSchemaV1.parse(item))
    .filter(
      (item) =>
        item.academicYear === link.academicYear &&
        item.studentId === link.studentId &&
        item.status !== 6,
    );
  const current = candidates.length === 1 ? candidates[0]! : null;
  return eligibilitySchemaV1.parse({
    contractVersion: 1,
    link,
    dataVersion,
    current,
    state:
      current === null
        ? 'unresolved'
        : [3, 4, 5].includes(current.status ?? 0)
          ? 'exit'
          : 'eligible',
  });
}

export interface AcademicEligibilityReaderV1<TTransaction> {
  readInTransaction(tx: TTransaction, link: PortalAcademicLinkV1): Promise<EligibilityV1>;
}
