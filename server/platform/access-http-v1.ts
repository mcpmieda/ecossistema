import { z } from 'zod';
import { ACCESS_AREA_IDS } from '../../shared/platform-contract';
import {
  ACCESS_PATH_V1,
  type AccessFailureStateV1,
  type AccessGrantsResponseV1,
} from '../../shared/platform-access-v1';
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
import { GraphError, graphRequest } from '../graph/client';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
  withSecurityHeaders,
} from '../http/security';

const changeSchemaV1 = z
  .object({
    id: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    email: z.string().max(320),
    areas: z.array(z.enum(ACCESS_AREA_IDS as [string, ...string[]])).max(ACCESS_AREA_IDS.length),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict();
const HISTORY_LIMIT_V1 = 50;

class AccessRefusalV1 extends Error {
  constructor(
    readonly state: AccessFailureStateV1,
    readonly status: number,
  ) {
    super(state);
  }
}

const reply = (value: AccessGrantsResponseV1 | { state: AccessFailureStateV1 }, status = 200) =>
  withSecurityHeaders(Response.json(value, { status }), true);

function failureV1(error: unknown): { state: AccessFailureStateV1; status: number } {
  if (error instanceof AccessRefusalV1) return { state: error.state, status: error.status };
  if (error instanceof AuthenticationError) return { state: 'refused', status: 401 };
  if (error instanceof AuthorizationError) return { state: 'refused', status: 403 };
  if (error instanceof HttpError && error.status < 500)
    return { state: error.status === 400 ? 'invalid-request' : 'refused', status: error.status };
  return { state: 'unavailable', status: 503 };
}

type PersonV1 = { oid: string; email: string };
type GraphUserV1 = { id: string; userPrincipalName?: string | null };

/** Characters Graph would read as part of the address, not of the name. */
const UNSAFE_LOOKUP_V1 = /[/\\?#%$]/u;

/** The Entra account with this sign-in name, or with this e-mail when only one has it. */
async function findPersonV1(env: RuntimeEnv, email: string): Promise<PersonV1 | null> {
  if (UNSAFE_LOOKUP_V1.test(email)) return null;
  const person = (user: GraphUserV1): PersonV1 => ({
    oid: user.id.toLowerCase(),
    email: normalizeAccessEmailV1(user.userPrincipalName ?? email),
  });
  try {
    const answer = await graphRequest<GraphUserV1>({
      env,
      path: `/users/${encodeURIComponent(email)}?$select=id,userPrincipalName`,
    });
    return person(answer.data);
  } catch (error) {
    // 400: Graph does not take this text as a sign-in name.
    if (!(error instanceof GraphError && (error.status === 404 || error.status === 400)))
      throw error;
  }
  const query = new URLSearchParams({
    $filter: `mail eq '${email.replaceAll("'", "''")}'`,
    $select: 'id,userPrincipalName',
    $top: '2',
  });
  const answer = await graphRequest<{ value: GraphUserV1[] }>({
    env,
    path: `/users?${query.toString()}`,
  });
  return answer.data.value.length === 1 ? person(answer.data.value[0]!) : null;
}

let findPersonOverrideV1: typeof findPersonV1 | undefined;
/** Tests replace Entra; `undefined` restores it. */
export function setAccessPeopleForTestsV1(find: typeof findPersonV1 | undefined): void {
  findPersonOverrideV1 = find;
}

/**
 * Configurações › Acessos (#1513): who outside the admin group may open which areas. Only the
 * administrator reads or changes it; a change reaches the person's open session within
 * GRANT_CACHE_MS_V1. Every change is kept in the history with who made it (#1530 A5).
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
      const actor = { oid: session.oid, name: session.name };
      let oid: string;
      if (parsed.data.id) {
        // An edit or a removal follows the grant's person, never the name shown (#1530 A3): no
        // Entra lookup, and nothing is written over a version changed meanwhile.
        oid = parsed.data.id;
        const changed = await port.change({ oid }, areas, actor, parsed.data.expectedUpdatedAt);
        if (changed === 'changed') throw new AccessRefusalV1('changed', 409);
      } else {
        if (areas.length === 0) throw new HttpError(400, 'Invalid request');
        const person = await (findPersonOverrideV1 ?? findPersonV1)(env, email);
        if (!person) throw new AccessRefusalV1('account-not-found', 404);
        oid = person.oid;
        if ((await port.change(person, areas, actor)) === 'changed')
          throw new AccessRefusalV1('changed', 409);
      }
      forgetAccessGrantV1(oid);
      console.log(JSON.stringify({ event: 'access_grant_changed', areas: areas.length }));
    }
    const [grants, history] = await Promise.all([port.list(), port.history(HISTORY_LIMIT_V1)]);
    return reply({
      contractVersion: 1,
      grants: grants.map(({ oid, ...grant }) => ({ id: oid, ...grant })),
      history,
    });
  } catch (error) {
    const { state, status } = failureV1(error);
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'access_grants_failed',
          message: error instanceof Error ? error.name : 'unknown',
        }),
      );
    return reply({ state }, status);
  }
}
