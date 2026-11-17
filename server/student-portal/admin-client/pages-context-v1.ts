import type { AccessArea } from '../../../shared/platform-contract';
import { areaCapabilityV1 } from '../../../shared/platform-contract';
import { capabilitiesForSession } from '../../auth/capabilities';
import { cloudflareClientIpV1 } from '../observability/audit-context-v1';
import { readSession, SESSION_COOKIE } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import type { TrustedAdminContextV1 } from '../../../shared/student-portal-contracts/ports-v1';

/** This adapter verifies the sealed ADM session itself; the browser never supplies RPC context.
 * `areas` are the Centro areas whose people may use this route (#1513); the administrator has all. */
export async function verifiedPagesContextV1(
  request: Request,
  env: RuntimeEnv,
  write: boolean,
  requestId: string,
  areas: readonly AccessArea[],
): Promise<TrustedAdminContextV1 | 'unauthenticated' | 'forbidden'> {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1) return 'unauthenticated';
  const session = await readSession(request, env);
  if (!session) return 'unauthenticated';
  const capability = write ? 'platform.settings.write' : 'platform.settings.read';
  const capabilities = capabilitiesForSession(session);
  if (!areas.some((area) => capabilities.includes(areaCapabilityV1(area)))) return 'forbidden';
  // Timestamp of this verification, not the first Entra sign-in: a valid twelve-hour session remains usable.
  return {
    actorId: session.oid,
    actorName: session.name,
    tenantId: env.TENANT_ID,
    requestId,
    capability,
    authenticatedAt: new Date().toISOString(),
    clientIp: cloudflareClientIpV1(request),
  };
}
