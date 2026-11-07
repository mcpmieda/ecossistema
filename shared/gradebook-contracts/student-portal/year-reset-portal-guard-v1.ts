import { z } from 'zod';
import {
  GRADEBOOK_ACADEMIC_YEAR_MAX_V2,
  GRADEBOOK_ACADEMIC_YEAR_MIN_V2,
} from '../academic-year-v2';
import { academicVersionSchemaV1 } from './academic-revision-v1';

const year = z
  .number()
  .int()
  .min(GRADEBOOK_ACADEMIC_YEAR_MIN_V2)
  .max(GRADEBOOK_ACADEMIC_YEAR_MAX_V2);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const YEAR_RESET_CONFIRMATION_WINDOW_MS_V1 = 300_000;
export const yearResetRelevantStateSchemaV1 = z
  .object({
    academicRevision: academicVersionSchemaV1,
    // Includes every effective write in the reset deletion set, not just academics.
    resetRevision: academicVersionSchemaV1,
    portalLinkRevision: academicVersionSchemaV1,
  })
  .strict();
export const yearResetPreviewProofSchemaV1 = z
  .object({
    contractVersion: z.literal(1),
    operation: z.literal('execute'),
    year,
    actorDigest: digest,
    tokenDigest: digest,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    state: yearResetRelevantStateSchemaV1,
    consumed: z.boolean(),
  })
  .strict()
  .refine((v) => {
    const duration = Date.parse(v.expiresAt) - Date.parse(v.issuedAt);
    return duration > 0 && duration <= YEAR_RESET_CONFIRMATION_WINDOW_MS_V1;
  }, 'Invalid confirmation window');
type YearResetPreviewProofV1 = z.infer<typeof yearResetPreviewProofSchemaV1>;

/** Pure comparison of trusted, persisted proof after locks; not token authentication or consumption. */
export function yearResetPreviewIsCurrentV1(
  proof: YearResetPreviewProofV1,
  context: {
    year: number;
    actorDigest: string;
    now: Date;
    state: z.infer<typeof yearResetRelevantStateSchemaV1>;
  },
): boolean {
  if (
    !yearResetPreviewProofSchemaV1.safeParse(proof).success ||
    !yearResetRelevantStateSchemaV1.safeParse(context.state).success
  )
    return false;
  const now = context.now.getTime();
  return (
    !proof.consumed &&
    proof.year === context.year &&
    proof.actorDigest === context.actorDigest &&
    now >= Date.parse(proof.issuedAt) &&
    now < Date.parse(proof.expiresAt) &&
    proof.state.academicRevision === context.state.academicRevision &&
    proof.state.resetRevision === context.state.resetRevision &&
    proof.state.portalLinkRevision === context.state.portalLinkRevision
  );
}

export const portalResetGuardResultSchemaV1 = z
  .object({
    year,
    state: z.enum(['clear', 'portal-linked-accounts']),
    portalLinkRevision: academicVersionSchemaV1,
  })
  .strict();
