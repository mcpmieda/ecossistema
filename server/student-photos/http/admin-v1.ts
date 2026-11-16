import { ZodError } from 'zod';
import type { RuntimeEnv } from '../../env';
import { verifiedPagesContextV1 } from '../../student-portal/admin-client/pages-context-v1';
import { portalJsonV1 } from '../../student-portal/runtime/http-v1';
import type { TrustedAdminContextV1 } from '../../../shared/student-portal-contracts/ports-v1';
import { studentUidV1 } from '../../../shared/student-identity/student-identity-v1';
import {
  PhotoWriteErrorV1,
  photoWriteContextV1,
  type PhotoWriteContextV1,
} from '../../../shared/student-photos/write-v1';
import { assertPhotoPreviewContextV1 } from '../../../shared/student-photos/preview-v1';
import {
  PHOTO_ADMIN_PATHS_V1,
  photoAdminPreviewRequestV1,
  photoAdminSaveRequestV1,
  photoAdminResponseV1,
  encodePhotoBytesV1,
  decodePhotoBytesV1,
  clearPhotoBytesV1,
  assertPhotoPreviewBytesV1,
  type PhotoAdminSubjectV1,
  type PhotoAdminFailureStateV1,
  type PhotoAdminResponseV1,
} from '../../../shared/student-photos/admin-http-v1';
import {
  readPhotoJsonV1,
  PhotoTransportReadErrorV1,
} from '../../../shared/student-photos/bounded-json-v1';
import type { PhotoEditServiceV1, PhotoPreviewResultV1 } from '../edit-service-v1';

export interface PhotoAdminHttpOptionsV1 {
  /** Server-controlled gate. Absent/false never consumes the image body. */
  enabled: boolean;
  /** Resolve the one authorized academic/account reference to its canonical identity.
   * Must check current student scope, not just existence or the manifest's actor. */
  resolveSubject(
    admin: TrustedAdminContextV1,
    subject: PhotoAdminSubjectV1,
    signal: AbortSignal,
  ): Promise<string>;
  /** Install the supplied verifier in the real service's mandatory authorize callback. */
  createService(
    authorize: (context: PhotoWriteContextV1) => Promise<void>,
  ): Pick<PhotoEditServiceV1, 'preview' | 'save'>;
}
class AccessError extends Error {
  constructor(readonly state: 'unauthenticated' | 'forbidden') {
    super(state);
  }
}
const statuses: Record<PhotoAdminFailureStateV1, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid: 400,
  'too-large': 413,
  timeout: 408,
  cancelled: 499,
  conflict: 409,
  busy: 409,
  'not-found': 404,
  unavailable: 503,
  disabled: 404,
};
function response(body: PhotoAdminResponseV1, status: number): Response {
  const result = portalJsonV1(photoAdminResponseV1.parse(body), status);
  result.headers.set('Cache-Control', 'private, no-store');
  result.headers.set('Vary', 'Cookie');
  return result;
}
function allowed(request: Request, env: RuntimeEnv): boolean {
  const url = new URL(request.url),
    environment = env.RUNTIME_ENVIRONMENT ?? 'production';
  if (environment === 'production' && env.OFFICIAL_ORIGIN !== 'https://admin.escolaieda.com')
    return false;
  if (
    environment !== 'production' &&
    (environment !== 'local' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    return false;
  if (url.origin !== env.OFFICIAL_ORIGIN || url.search || url.hash || url.username || url.password)
    return false;
  const host = request.headers.get('host');
  if (host && host.toLowerCase() !== url.host.toLowerCase()) return false;
  if (request.headers.has('x-forwarded-host') || request.headers.has('x-original-url'))
    return false;
  if (
    request.headers.get('origin') !== env.OFFICIAL_ORIGIN ||
    request.headers.get('x-student-photo-request') !== '1'
  )
    return false;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}
async function identity(
  request: Request,
  env: RuntimeEnv,
  traceId: string,
): Promise<TrustedAdminContextV1> {
  request.signal.throwIfAborted();
  const context = await verifiedPagesContextV1(request, env, true, traceId);
  if (typeof context === 'string') throw new AccessError(context);
  request.signal.throwIfAborted();
  return context;
}
function failure(error: unknown, signal: AbortSignal): PhotoAdminFailureStateV1 {
  if (error instanceof AccessError) return error.state;
  if (error instanceof PhotoTransportReadErrorV1) return error.code;
  if (error instanceof PhotoWriteErrorV1)
    return error.code === 'receipt-conflict' ? 'conflict' : error.code;
  if (signal.aborted) return 'cancelled';
  if (error instanceof ZodError) return 'invalid';
  return 'unavailable';
}
function unavailableCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (
    /^student-photo-codec-(?:input|dimensions|metadata|decode|alpha|encode|output-size|unavailable)$/u.test(
      error.message,
    )
  )
    return error.message;
  return error.name;
}
function classifiedFailure(error: unknown, signal: AbortSignal): PhotoAdminFailureStateV1 {
  const state = failure(error, signal);
  if (state === 'unavailable')
    console.error('student-photo-edit-unavailable', unavailableCategory(error));
  return state;
}
async function previewResponse(
  result: PhotoPreviewResultV1,
  context: PhotoWriteContextV1,
  command: PhotoAdminPreviewRequestV1['command'],
  traceId: string,
): Promise<Response> {
  try {
    assertPhotoPreviewContextV1(result.approval, context, command);
    await assertPhotoPreviewBytesV1(result.approval, result.images);
    return response(
      {
        version: 1,
        traceId,
        state: 'preview',
        approval: result.approval,
        images: encodePhotoBytesV1(result.images),
      },
      200,
    );
  } finally {
    clearPhotoBytesV1(result.images);
  }
}
type PhotoAdminPreviewRequestV1 = ReturnType<typeof photoAdminPreviewRequestV1.parse>;

/** Standalone ADM boundary. Not mounted with placeholder services, not a Portal/Graph proxy. */
export async function servePhotoAdminV1(
  request: Request,
  env: RuntimeEnv,
  options: PhotoAdminHttpOptionsV1,
): Promise<Response> {
  const traceId = crypto.randomUUID();
  const fail = (state: PhotoAdminFailureStateV1) =>
    response({ version: 1, traceId, state }, statuses[state]);
  const path = new URL(request.url).pathname;
  if (path !== PHOTO_ADMIN_PATHS_V1.preview && path !== PHOTO_ADMIN_PATHS_V1.save)
    return fail('not-found');
  if (options.enabled !== true) return fail('disabled');
  if (request.method !== 'POST') return fail('invalid');
  if (!allowed(request, env)) return fail('forbidden');
  try {
    const initial = await identity(request, env, traceId);
    const raw = await readPhotoJsonV1(request, request.signal);
    const input =
      path === PHOTO_ADMIN_PATHS_V1.preview
        ? photoAdminPreviewRequestV1.parse(raw)
        : photoAdminSaveRequestV1.parse(raw);
    const fresh = await identity(request, env, traceId);
    if (
      fresh.actorId.toLowerCase() !== initial.actorId.toLowerCase() ||
      fresh.tenantId !== initial.tenantId
    )
      throw new AccessError('forbidden');
    const context = photoWriteContextV1.parse({
      actorId: fresh.actorId,
      studentUid: await options.resolveSubject(fresh, input.subject, request.signal),
    });
    const authorize = async (candidate: PhotoWriteContextV1) => {
      if (candidate.actorId !== context.actorId || candidate.studentUid !== context.studentUid)
        throw new AccessError('forbidden');
      const current = await identity(request, env, traceId);
      if (
        current.actorId.toLowerCase() !== context.actorId ||
        current.tenantId !== initial.tenantId
      )
        throw new AccessError('forbidden');
      const uid = studentUidV1.parse(
        await options.resolveSubject(current, input.subject, request.signal),
      );
      if (uid !== context.studentUid) throw new AccessError('forbidden');
      request.signal.throwIfAborted();
    };
    // Decode image data only after the specific student reference has been authorized.
    await authorize(context);
    const images = decodePhotoBytesV1(input.images);
    try {
      const service = options.createService(authorize);
      if ('qualities' in input) {
        const result = await service.preview(
          context,
          input.command,
          input.qualities,
          images,
          request.signal,
        );
        try {
          await authorize(context);
        } catch (error) {
          clearPhotoBytesV1(result.images);
          throw error;
        }
        return await previewResponse(result, context, input.command, traceId);
      }
      const result = await service.save(
        context,
        input.command,
        input.approval,
        images,
        request.signal,
      );
      if (result.requestId !== input.command.requestId) return fail('unavailable');
      // Do not turn an already committed write into a false failure after permission loss.
      return response({ version: 1, traceId, ...result }, result.state === 'pending' ? 202 : 200);
    } finally {
      clearPhotoBytesV1(images);
    }
  } catch (error) {
    return fail(classifiedFailure(error, request.signal));
  }
}
