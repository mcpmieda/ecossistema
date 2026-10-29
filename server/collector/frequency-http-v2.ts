import { z } from 'zod';
import {
  FREQUENCY_BODY_BYTES_V2,
  frequencyRequestV2,
  type FrequencyActorV2,
  type FrequencyRequestV2,
} from '../../shared/attendance-contracts/frequency-v2';
import type { RuntimeEnv } from '../env';
import { requireAuth, AuthenticationError } from '../auth/session';
import { requireRole, AuthorizationError } from '../auth/roles';
import { readBoundedJson, enforceWriteOrigin, HttpError } from '../http/security';
import { createFrequencyServiceV2, FrequencyErrorV2 } from '../attendance/service-v2';
import {
  frequencyFailureDetailV2,
  recordFrequencyFailureV2,
  type FrequencyFailureOriginV2,
} from '../attendance/failure-log-v2';
import type { GradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import { withOfficialGradebookDatabaseV1 } from '../gradebook/persistence/postgres/official-gradebook-database-v1';
import { CollectorAccessErrorV1, type CollectorAccessServiceV1 } from './access-service-v1';

const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      Vary: 'Cookie, Authorization',
    },
  });
const proofSchema = z
  .object({
    deviceId: z.uuid(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  })
  .strict();
/** Expected while a reserve computer waits or the school is paused: not failures. */
// 'payload-required' is the expected answer to an unchanged diary the server cannot confirm.
const ROUTINE = new Set(['lease-busy', 'paused', 'payload-required']);

function failed(error: unknown): Response {
  if (error instanceof FrequencyErrorV2)
    return reply({ contractVersion: 2, state: error.code }, error.status);
  if (error instanceof AuthenticationError)
    return reply({ contractVersion: 2, state: 'not-authorized' }, 401);
  if (
    error instanceof AuthorizationError ||
    (error instanceof CollectorAccessErrorV1 && error.reason !== 'unavailable')
  )
    return reply({ contractVersion: 2, state: 'not-authorized' }, 403);
  if (error instanceof HttpError)
    return reply({ contractVersion: 2, state: 'invalid-request' }, error.status);
  if (error instanceof z.ZodError)
    return reply({ contractVersion: 2, state: 'invalid-request' }, 400);
  return reply({ contractVersion: 2, state: 'unavailable' }, 503);
}
function database(env: RuntimeEnv): GradebookPostgresDatabaseV1 {
  const value = env.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1 | undefined;
  if (!value?.transaction) throw new Error('frequency-database-unavailable');
  return value;
}
function failureDetail(error: unknown, db: GradebookPostgresDatabaseV1): string {
  if (error instanceof FrequencyErrorV2) return error.detail;
  try {
    return frequencyFailureDetailV2(error, db.lastFailure());
  } catch {
    return frequencyFailureDetailV2(error);
  }
}
function classOf(payload: FrequencyRequestV2): number | null {
  return 'classId' in payload && typeof payload.classId === 'number' ? payload.classId : null;
}

/** Runs one authorized operation; a failure is recorded after its transaction rolled back. */
async function execute(
  env: RuntimeEnv,
  origin: FrequencyFailureOriginV2,
  payload: FrequencyRequestV2,
  actor: FrequencyActorV2,
): Promise<Response> {
  const result = await withOfficialGradebookDatabaseV1(env, async (execution) => {
    const db = database(execution);
    try {
      return reply(await createFrequencyServiceV2(db).execute(payload, actor));
    } catch (error) {
      const code = error instanceof FrequencyErrorV2 ? error.code : 'unavailable';
      if (!ROUTINE.has(code))
        await recordFrequencyFailureV2(db, {
          origin,
          operation: payload.operation,
          code,
          detail: failureDetail(error, db),
          deviceId: actor.deviceId ?? null,
          classId: classOf(payload),
        });
      throw error;
    }
  });
  return result ?? reply({ contractVersion: 2, state: 'unavailable' }, 503);
}

/** Payload-bound device proof is the only desktop authority. No browser cookie authorizes a device. */
export async function handleCollectorFrequencyRequestV2(
  request: Request,
  env: RuntimeEnv,
  access: Pick<CollectorAccessServiceV1, 'authorizeFrequency'>,
): Promise<Response> {
  try {
    if (request.method !== 'POST')
      return reply({ contractVersion: 2, state: 'invalid-request' }, 405);
    const official =
      new URL(request.url).origin === 'https://admin.escolaieda.com' &&
      env.OFFICIAL_ORIGIN === 'https://admin.escolaieda.com';
    const foreign =
      request.headers.has('Origin') && request.headers.get('Origin') !== env.OFFICIAL_ORIGIN;
    if (!official || foreign) return reply({ contractVersion: 2, state: 'not-authorized' }, 403);
    const input = z
      .object({ proof: proofSchema, payload: frequencyRequestV2 })
      .strict()
      .parse(await readBoundedJson(request, FREQUENCY_BODY_BYTES_V2));
    const actor = await access.authorizeFrequency(input.proof, input.payload);
    return await execute(env, 'collector', input.payload, actor);
  } catch (error) {
    return failed(error);
  }
}

/** Same service and rules; the site's verified ADMINISTRADOR session is independent of the device grant. */
export async function handleFrequencyAdminRequestV2(
  request: Request,
  env: RuntimeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/gradebook/frequency/v2') return null;
  try {
    if (new URL(request.url).origin !== env.OFFICIAL_ORIGIN)
      return reply({ contractVersion: 2, state: 'not-authorized' }, 403);
    if (request.method !== 'POST')
      return reply({ contractVersion: 2, state: 'invalid-request' }, 405);
    enforceWriteOrigin(request, env);
    const session = await requireAuth(request, env);
    requireRole(session.roles, 'ADMINISTRADOR');
    const input = frequencyRequestV2.parse(await readBoundedJson(request, FREQUENCY_BODY_BYTES_V2));
    if (
      ['lease', 'heartbeat', 'release', 'collect', 'collect-unchanged', 'schedule-collect', 'incident-collect'].includes(
        input.operation,
      )
    )
      return reply({ contractVersion: 2, state: 'not-authorized' }, 403);
    return await execute(env, 'admin', input, {
      mode: 'admin',
      actorId: session.oid,
      tenantId: env.TENANT_ID,
    });
  } catch (error) {
    return failed(error);
  }
}
