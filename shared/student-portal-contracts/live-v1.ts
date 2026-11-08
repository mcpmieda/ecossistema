import { z } from 'zod';
import { trustedAdminContextV1 } from './admin-v1';
import { instantV1, portalIdV1, revisionV1 } from './core-v1';

export const liveAudienceV1 = z.enum(['admin', 'student']);
const liveDomainV1 = z.enum(['gradebook', 'portal']);
const liveCursorV1 = z.string().regex(/^\d{20}$/u);

export const liveResumeV1 = z
  .object({
    contractVersion: z.literal(1),
    type: z.literal('resume'),
    cursor: liveCursorV1.nullable(),
  })
  .strict();

/** Internal service/DO message. Routing fields are consumed server-side and never serialized to a browser. */
export const livePublishEventV1 = z
  .object({
    securityRelevant: z.boolean().optional(),
    cursor: liveCursorV1,
    audience: liveAudienceV1,
    domain: liveDomainV1,
    version: revisionV1,
    occurredAt: instantV1,
    accountId: portalIdV1.nullable(),
    classId: z.number().int().positive().safe().nullable(),
    studentIds: z.array(z.number().int().positive().safe()).max(1000),
  })
  .strict();
export type LivePublishEventV1 = z.infer<typeof livePublishEventV1>;

export const liveAdminContextV1 = z
  .object({
    actorId: portalIdV1,
    tenantId: portalIdV1,
    expiresAt: instantV1,
    capability: z.literal('platform.settings.read'),
  })
  .strict();

/** Private binding metadata; the ADM must authorize the real BN session before calling. */
export const liveDrainContextV1 = trustedAdminContextV1.extend({
  capability: z.literal('gradebook.persistence.admin'),
});
export type LiveDrainContextV1 = z.infer<typeof liveDrainContextV1>;
