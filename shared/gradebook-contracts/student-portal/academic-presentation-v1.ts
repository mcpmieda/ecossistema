import { z } from 'zod';

/** Existing V1 wire value: null means unclassified, never below minimum. */
export const academicMeetsMinimumSchemaV1 = z.boolean().nullable();
export type AcademicMeetsMinimumV1 = z.infer<typeof academicMeetsMinimumSchemaV1>;

/**
 * Internal BN input, not an HTTP request or a browser-controlled policy.
 * Values are normalized integer thousandths from one academic snapshot.
 * A missing/nonpositive maximum is unclassified; it is never a denominator.
 * Missing value or annual minimum is likewise unclassified. Invalid numeric
 * representations must be rejected, not coerced to zero or rounded.
 */
export const academicPresentationInputSchemaV1 = z
  .object({
    valueMilli: z.number().int().nonnegative().safe().nullable(),
    maximumMilli: z.number().int().safe().nullable(),
    minimumApprovalMilli: z.number().int().positive().safe().nullable(),
  })
  .strict();
export type AcademicPresentationInputV1 = z.infer<typeof academicPresentationInputSchemaV1>;

/**
 * Implemented only by the BN domain helper, never by this schema/UI.
 * For classified scores: value * annualMaximum >= maximum * annualMinimum,
 * using exact integer products; equality passes, with no clamping/tolerance.
 * annualMaximum is the sum of the existing BN term maxima, not a new policy.
 * This classifies presentation; it never changes AM/U, REC eligibility,
 * Council decisions, or the annual outcome. Non-numeric marks retain kind.
 */
export type ResolveStudentMarkPresentationV1 = (
  input: AcademicPresentationInputV1,
) => AcademicMeetsMinimumV1;
