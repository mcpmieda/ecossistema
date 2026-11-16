import { liveDrainContextV1 } from '../../../shared/student-portal-contracts/live-v1';
import type { PortalCompositionEnvV1 } from './config-v1';

/** Named ADM service capability only; never accepted from a public HTTP route. */
export function allowPortalLiveDrainV1(env: PortalCompositionEnvV1, input: unknown): boolean {
  const parsed = liveDrainContextV1.safeParse(input);
  if (!parsed.success) return false;
  const age = Date.now() - Date.parse(parsed.data.authenticatedAt);
  return (
    env.PORTAL_ENVIRONMENT === 'production' &&
    env.PORTAL_SERVING_ENABLED === 'true' &&
    age >= 0 &&
    age <= 300_000 &&
    parsed.data.tenantId.toLowerCase() === env.PORTAL_ADMIN_TENANT_ID?.toLowerCase()
  );
}
