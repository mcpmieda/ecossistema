import type { RuntimeEnv } from '../../../server/env';
import { requireAuth, AuthenticationError } from '../../../server/auth/session';
import { AuthorizationError } from '../../../server/auth/roles';
import { capabilitiesForRoles, requireCapability } from '../../../server/auth/capabilities';
import { enforceOfficialOrigin, HttpError, withSecurityHeaders } from '../../../server/http/security';
import { getPlatformSnapshotCachedV2 } from '../../../server/platform/snapshot';

/** Legacy clients keep their all-or-nothing endpoint. V2 identifies unavailable sections
 * and preserves Retry-After without confusing an upstream failure with a user's permissions.
 */
export const onRequest: PagesFunction<RuntimeEnv> = async (context) => {
  const correlationId = crypto.randomUUID();
  try {
    enforceOfficialOrigin(context.request, context.env);
    if (context.request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const session = await requireAuth(context.request, context.env);
    const capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.snapshot.read');
    const snapshot = await getPlatformSnapshotCachedV2(context.env, capabilities);
    const headers = new Headers();
    if (snapshot.retryAfterSeconds !== undefined) headers.set('Retry-After', String(snapshot.retryAfterSeconds));
    return withSecurityHeaders(Response.json(snapshot, { headers }), true);
  } catch (error) {
    const status = error instanceof HttpError || error instanceof AuthenticationError || error instanceof AuthorizationError ? error.status : 503;
    return withSecurityHeaders(Response.json({ error: 'Platform snapshot unavailable', correlationId }, { status }), true);
  }
};
