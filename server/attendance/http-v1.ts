import { z } from 'zod';
import {
  ATTENDANCE_BODY_BYTES_V1,
  ATTENDANCE_CONTRACT_V1,
  attendanceScopeV1,
} from '../../shared/attendance-contracts/attendance-v1';
import { studentUidV1 } from '../../shared/student-identity/student-identity-v1';
import { AuthenticationError, requireAuth } from '../auth/session';
import { AuthorizationError } from '../auth/roles';
import type { RuntimeEnv } from '../env';
import {
  enforceOfficialOrigin,
  enforceWriteOrigin,
  HttpError,
  readBoundedJson,
} from '../http/security';
import type { AttendanceServiceV1 } from './service-v1';
import { AttendanceErrorV1 } from './domain-v1';

export const ATTENDANCE_ROUTE_V1 = '/api/attendance/v1';
const responsibleRequest = z
  .object({
    operation: z.literal('monthly-summary'),
    scope: attendanceScopeV1,
    studentUid: studentUidV1,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  })
  .strict();
export type AttendanceResponsibleRequestV1 = z.infer<typeof responsibleRequest>;

export const ATTENDANCE_PRIVATE_HEADERS_V1 = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Expires: '0',
  Pragma: 'no-cache',
  Vary: 'Cookie, Authorization',
};

/** Prepared API boundary; intentionally NOT mounted in the production router.
 * Collector/admin operations inherit Entra and gradebook.persistence.admin.
 * Responsible access must be provided by the existing identity/permission system;
 * absent that integration, monthly summaries fail closed. No new credentials.
 */
export function createAttendanceRequestHandlerV1(dependencies: {
  service: AttendanceServiceV1;
  authorizeResponsible?: (
    request: Request,
    input: AttendanceResponsibleRequestV1,
  ) => Promise<boolean>;
}) {
  return async (request: Request, env: RuntimeEnv): Promise<Response | null> => {
    if (new URL(request.url).pathname !== ATTENDANCE_ROUTE_V1) return null;
    const respond = (value: unknown, status: number) =>
      Response.json(
        {
          contractVersion: ATTENDANCE_CONTRACT_V1,
          ...(value as Record<string, unknown>),
        },
        { status, headers: ATTENDANCE_PRIVATE_HEADERS_V1 },
      );
    try {
      enforceOfficialOrigin(request, env);
      if (request.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
      enforceWriteOrigin(request, env);
      const payload = await readBoundedJson(request, ATTENDANCE_BODY_BYTES_V1);
      if (
        payload !== null &&
        typeof payload === 'object' &&
        'operation' in payload &&
        payload.operation === 'monthly-summary'
      ) {
        const input = responsibleRequest.parse(payload);
        const result = await dependencies.service.responsibleSummary(
          input,
          () => dependencies.authorizeResponsible?.(request, input) ?? Promise.resolve(false),
        );
        return respond({ state: 'ready', ...result }, 200);
      }
      const session = await requireAuth(request, env);
      return respond(
        { state: 'ready', ...(await dependencies.service.execute(payload, session)) },
        200,
      );
    } catch (cause) {
      if (cause instanceof AttendanceErrorV1) return respond({ state: cause.code }, cause.status);
      if (cause instanceof AuthenticationError) return respond({ state: 'not-authorized' }, 401);
      if (cause instanceof AuthorizationError) return respond({ state: 'not-authorized' }, 403);
      if (cause instanceof z.ZodError) return respond({ state: 'invalid-request' }, 400);
      if (cause instanceof HttpError) return respond({ state: 'invalid-request' }, cause.status);
      // No payload, database exception or student information in public error responses/logs.
      return respond({ state: 'unavailable' }, 503);
    }
  };
}
