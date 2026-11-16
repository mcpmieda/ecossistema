import type { RuntimeEnv } from '../../../server/env';
import { requireAuth, AuthenticationError } from '../../../server/auth/session';
import { AuthorizationError } from '../../../server/auth/roles';
import { capabilitiesForRoles, requireCapability } from '../../../server/auth/capabilities';
import {
  enforceOfficialOrigin,
  HttpError,
  withSecurityHeaders,
} from '../../../server/http/security';
import { buildPlatformSnapshot } from '../../../server/platform/snapshot';

/** Only the native capability-filtered module catalog. */
export const onRequest: PagesFunction<RuntimeEnv> = async (context) => {
  const correlationId = crypto.randomUUID();
  try {
    enforceOfficialOrigin(context.request, context.env);
    if (context.request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const session = await requireAuth(context.request, context.env);
    const capabilities = capabilitiesForRoles(session.roles);
    requireCapability(capabilities, 'platform.snapshot.read');
    return withSecurityHeaders(
      Response.json(buildPlatformSnapshot({ correlationId }, capabilities)),
      true,
    );
  } catch (error) {
    const status =
      error instanceof HttpError ||
      error instanceof AuthenticationError ||
      error instanceof AuthorizationError
        ? error.status
        : 503;
    return withSecurityHeaders(
      Response.json({ error: 'Platform bootstrap unavailable', correlationId }, { status }),
      true,
    );
  }
};
