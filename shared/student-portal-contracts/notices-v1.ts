import { z } from 'zod';
import { instantV1, periodV1, portalIdV1 } from './core-v1';

/** What the Portal tells students about its own state (owner decision, 26/09/2026). Only the
 * policy's dates and switches: never grades or anything about another student.
 */
export const portalNoticesV1 = z
  .object({
    /** Whether a student may be signed in right now. */
    access: z.enum(['open', 'closed']),
    /** A configured future opening while access is closed. */
    accessOpensAt: instantV1.nullable(),
    /** The next configured "Liberar notas em" still in the future (countdown). */
    gradesReleaseAt: instantV1.nullable(),
    /** The most recent "Ocultar notas em" already past: grades of that period are no longer shown. */
    disclosureEnded: z.object({ period: periodV1.nullable(), at: instantV1 }).strict().nullable(),
  })
  .strict();
export type PortalNoticesV1 = z.infer<typeof portalNoticesV1>;

/** `school` before sign-in (school policy); `student` with a valid session (that student's policy). */
export const portalStatusResponseV1 = z
  .object({
    contractVersion: z.literal(1),
    requestId: portalIdV1,
    state: z.literal('status'),
    scope: z.enum(['school', 'student']),
    /** Server clock: countdowns run on it, not on a phone clock that may be wrong. */
    serverNow: instantV1,
    notices: portalNoticesV1,
  })
  .strict();
