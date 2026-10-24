import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { requireAuth, AuthenticationError } from '../auth/session';
import { AuthorizationError } from '../auth/roles';
import { capabilitiesForRoles, requireCapability } from '../auth/capabilities';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
  withSecurityHeaders,
} from '../http/security';
import { healthDeadlineV1 } from '../../shared/health-io-v1';
import {
  PUBLIC_DEMO_ADMIN_PATH_V1,
  publicDemoStateSchemaV1,
  publicDemoChangeSchemaV1,
  type PublicDemoControlBindingV1,
  type PublicDemoAuthorityV1,
} from '../../shared/public-demo-control-v1';

const reply = (value: unknown, status = 200) =>
  withSecurityHeaders(Response.json(value, { status }), true);
export async function handlePublicDemoRequestV1(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PUBLIC_DEMO_ADMIN_PATH_V1) return null;
  try {
    enforceOfficialOrigin(request, env);
    enforceWriteOrigin(request, env);
    if (url.search || request.headers.get('sec-fetch-site') === 'cross-site')
      throw new HttpError(403, 'forbidden');
    if (request.method !== 'POST') throw new HttpError(405, 'method');
    const session = await requireAuth(request, env);
    const body = await healthDeadlineV1(() => readBoundedJson(request, 256), 2000);
    const read = z.object({}).strict().safeParse(body).success;
    const capability = !read ? 'platform.settings.write' : 'platform.settings.read';
    requireCapability(capabilitiesForRoles(session.roles), capability);
    const authority: PublicDemoAuthorityV1 = {
      actorId: session.oid,
      tenantId: env.TENANT_ID,
      requestId: crypto.randomUUID(),
      authenticatedAt: new Date().toISOString(),
      capability,
    };
    const binding = env.PUBLIC_DEMO_CONTROL as PublicDemoControlBindingV1 | undefined;
    if (!binding) throw new Error('unavailable');
    if (read)
      return reply(
        publicDemoStateSchemaV1.parse(
          await healthDeadlineV1(() => binding.getState(authority), 5000),
        ),
      );
    const parsed = publicDemoChangeSchemaV1.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid-body');
    const result = z
      .object({ ok: z.boolean(), state: publicDemoStateSchemaV1 })
      .strict()
      .parse(await healthDeadlineV1(() => binding.setEnabled(authority, parsed.data), 5000));
    return reply(result, result.ok ? 200 : 409);
  } catch (error) {
    let status;
    if (error instanceof AuthenticationError) {
      status = 401;
    } else if (error instanceof AuthorizationError) {
      status = 403;
    } else if (error instanceof HttpError) {
      status = error.status;
    } else {
      status = 503;
    }
    return reply({ error: status === 503 ? 'demo-unavailable' : 'demo-request-rejected' }, status);
  }
}
