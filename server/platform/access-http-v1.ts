import { z } from 'zod';
import { ACCESS_AREA_IDS } from '../../shared/platform-contract';
import { ACCESS_PATH_V1, type AccessGrantsResponseV1 } from '../../shared/platform-access-v1';
import {
  ACCESS_EMAIL_PATTERN_V1,
  accessGrantsPortV1,
  forgetAccessGrantV1,
  normalizeAccessEmailV1,
} from '../auth/access-grants-v1';
import { capabilitiesForSession, requireCapability } from '../auth/capabilities';
import { AuthorizationError } from '../auth/roles';
import { AuthenticationError, requireAuth } from '../auth/session';
import type { RuntimeEnv } from '../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
  withSecurityHeaders,
} from '../http/security';

const changeSchemaV1 = z
  .object({
    email: z.string().max(320),
    areas: z.array(z.enum(ACCESS_AREA_IDS as [string, ...string[]])).max(ACCESS_AREA_IDS.length),
  })
  .strict();

const reply = (value: AccessGrantsResponseV1 | { state: string }, status = 200) =>
  withSecurityHeaders(Response.json(value, { status }), true);

function failureStatusV1(error: unknown): number {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof AuthorizationError) return 403;
  return error instanceof HttpError ? error.status : 503;
}

/**
 * Configurações › Acessos (#1513): who outside the admin group may open which areas. Only the
 * administrator reads or changes it; a change reaches the person's open session within
 * GRANT_CACHE_MS_V1.
 */
export async function handleAccessRequestV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== ACCESS_PATH_V1) return null;
  try {
    enforceOfficialOrigin(request, env);
    if (request.method !== 'GET' && request.method !== 'PUT')
      throw new HttpError(405, 'Method not allowed');
    const session = await requireAuth(request, env);
    const capabilities = capabilitiesForSession(session);
    requireCapability(capabilities, 'platform.settings.read');
    const port = accessGrantsPortV1(env);
    if (!port) throw new HttpError(503, 'Unavailable');

    if (request.method === 'PUT') {
      enforceWriteOrigin(request, env);
      requireCapability(capabilities, 'platform.settings.write');
      const parsed = changeSchemaV1.safeParse(await readBoundedJson(request, 2048));
      if (!parsed.success) throw new HttpError(400, 'Invalid request');
      const email = normalizeAccessEmailV1(parsed.data.email);
      if (!ACCESS_EMAIL_PATTERN_V1.test(email)) throw new HttpError(400, 'Invalid request');
      const areas = ACCESS_AREA_IDS.filter((area) => parsed.data.areas.includes(area));
      await port.save(email, areas, { name: session.name });
      forgetAccessGrantV1(email);
      console.log(JSON.stringify({ event: 'access_grant_changed', areas: areas.length }));
    }
    return reply({ contractVersion: 1, grants: await port.list() });
  } catch (error) {
    const status = failureStatusV1(error);
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'access_grants_failed',
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
    return reply({ state: status === 503 ? 'unavailable' : 'refused' }, status);
  }
}
