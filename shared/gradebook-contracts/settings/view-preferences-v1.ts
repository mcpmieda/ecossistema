import { z } from 'zod';

/*
 * What each person last chose on the Centro's screens (area, period, perspective, filters),
 * kept per account so another computer opens on the same view (owner request of 12/11/2026).
 * Only identifiers of choices travel here; each screen revalidates them against what it reads.
 */
export const VIEW_PREFERENCE_KEY_PATTERN_V1 = /^[a-z][a-z0-9-]{0,63}(?::\d{1,6})?$/u;
export const VIEW_PREFERENCE_MAX_VALUE_CHARS_V1 = 2048;
export const VIEW_PREFERENCE_MAX_KEYS_V1 = 64;

const viewKeySchemaV1 = z.string().regex(VIEW_PREFERENCE_KEY_PATTERN_V1);
const viewValueSchemaV1 = z
  .unknown()
  .refine((value) => value !== undefined, 'missing')
  .refine((value) => {
    try {
      return JSON.stringify(value).length <= VIEW_PREFERENCE_MAX_VALUE_CHARS_V1;
    } catch {
      return false;
    }
  }, 'too-large');

const viewsSchemaV1 = z
  .record(viewKeySchemaV1, viewValueSchemaV1)
  .refine((views) => Object.keys(views).length <= VIEW_PREFERENCE_MAX_KEYS_V1, 'too-many');

export const viewPreferencesSaveSchemaV1 = z
  .object({ views: viewsSchemaV1.refine((views) => Object.keys(views).length > 0, 'empty') })
  .strict();
export type ViewPreferencesSaveV1 = z.infer<typeof viewPreferencesSaveSchemaV1>;

export const viewPreferencesResponseSchemaV1 = z.discriminatedUnion('state', [
  z.object({ contractVersion: z.literal(1), state: z.literal('ready'), views: viewsSchemaV1 }).strict(),
  z.object({
    contractVersion: z.literal(1),
    state: z.enum(['invalid-request', 'not-authorized', 'unavailable']),
  }).strict(),
]);
export type ViewPreferencesResponseV1 = z.infer<typeof viewPreferencesResponseSchemaV1>;
