import { photoFallbackHueV1 } from '../../../shared/student-photos/crop-v1';
import { z } from 'zod';
import type { RuntimeEnv } from '../../env';
import { verifiedPagesContextV1 } from '../../student-portal/admin-client/pages-context-v1';
import { studentUidV1 } from '../../../shared/student-identity/student-identity-v1';
import { photoWriteContextV1, type PhotoWriteContextV1, PhotoWriteErrorV1 } from '../../../shared/student-photos/write-v1';
import { photoAdminSubjectV1, PHOTO_ADMIN_PATHS_V1, type PhotoAdminSubjectV1 } from '../../../shared/student-photos/admin-http-v1';
import { photoCatalogRequestV1 } from '../../../shared/student-photos/catalog-v1';
import { readPhotoJsonV1, PhotoTransportReadErrorV1 } from '../../../shared/student-photos/bounded-json-v1';
import { openPhotoDatabaseV1 } from '../runtime-database-v1';
import { PhotoCatalogRepositoryV1 } from '../catalog-repository-v1';
import { createPhotoRuntimeServiceV1 } from '../runtime-service-v1';
import type { StudentWebpCodecV1 } from '../webp-codec-v1';
import { servePhotoAdminV1 } from './admin-v1';
import { PhotoStorageV1 } from '../storage-v1';
import { readAvatarBatchV1 } from '../avatar-batch-service-v1';
import { PHOTO_AVATAR_BATCH_PATH_V1, PHOTO_AVATAR_BATCH_TYPE_V1, encodePhotoAvatarBatchV1,
  photoAvatarBatchRequestV1 } from '../../../shared/student-photos/avatar-batch-v1';

const paths = {
  state: '/api/student-photos/admin/state', open: '/api/student-photos/admin/open',
  recover: '/api/student-photos/admin/recover', image: '/api/student-photos/admin/image',
  avatars: PHOTO_AVATAR_BATCH_PATH_V1,
};
const recoverRequest = photoCatalogRequestV1.extend({ requestId: studentUidV1 }).strict();
const imageQuery = z.object({ source: z.enum(['portal', 'gradebook']),
  year: z.string().regex(/^\d{4}$/u), reference: z.string().min(1).max(40),
  variant: z.enum(['portrait', 'avatar']), v: studentUidV1.optional() }).strict();
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders });
}
class AccessDenied extends Error {
  constructor(readonly status: 401 | 403) { super('photo-access-denied'); }
}
function requestAllowed(request: Request, env: RuntimeEnv, image: boolean) {
  const url = new URL(request.url);
  if (url.origin !== env.OFFICIAL_ORIGIN || url.hash || url.username || url.password) return false;
  const host = request.headers.get('host');
  if (host && host.toLowerCase() !== url.host.toLowerCase()) return false;
  if (request.headers.has('x-forwarded-host') || request.headers.has('x-original-url')) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;
  if (image) return request.method === 'GET';
  return request.method === 'POST' && !url.search
    && request.headers.get('origin') === env.OFFICIAL_ORIGIN
    && request.headers.get('x-student-photo-request') === '1';
}
function readImageQuery(url: URL) {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) throw new PhotoWriteErrorV1('invalid');
    values[key] = value;
  }
  const value = imageQuery.parse(values);
  const subject = photoAdminSubjectV1.parse(value.source === 'portal'
    ? { source: 'portal', academicYear: Number(value.year), accountIds: [value.reference] }
    : { source: 'gradebook', academicYear: Number(value.year), studentIds: [Number(value.reference)] });
  return { subject, variant: value.variant, revision: value.v ?? null };
}

/** A recovery request, or a catalog request naming its student. */
function photoRequestInputV1(path: string, raw: unknown) {
  return path === paths.recover ? recoverRequest.parse(raw) : photoCatalogRequestV1.parse(raw);
}

/** Whether the same reader may also change this student's photo. */
async function mayWriteV1(
  request: Request,
  env: RuntimeEnv,
  traceId: string,
  reader: { actorId: string; tenantId: string },
) {
  const writeContext = await verifiedPagesContextV1(request, env, true, traceId);
  return typeof writeContext !== 'string' && writeContext.actorId.toLowerCase() === reader.actorId
    && writeContext.tenantId === reader.tenantId;
}

/** The signed-in reader of the Pages session; a missing or refused one is denied (401 or 403). */
async function requirePagesContextV1(request: Request, env: RuntimeEnv, write: boolean, traceId: string) {
  const context = await verifiedPagesContextV1(request, env, write, traceId);
  if (typeof context === 'string') throw new AccessDenied(context === 'unauthenticated' ? 401 : 403);
  return context;
}

type PagesContextV1 = Awaited<ReturnType<typeof requirePagesContextV1>>;

/** The joint avatar read: read-only, the same reader checked again before each image goes out. */
async function serveAvatarBatchV1(
  request: Request,
  env: RuntimeEnv,
  repository: PhotoCatalogRepositoryV1,
  initial: PagesContextV1,
  traceId: string,
) {
  const batch = photoAvatarBatchRequestV1.parse(await readPhotoJsonV1(request, request.signal));
  // Read-only transport: any upload or removal attempted through it is refused.
  const storage = new PhotoStorageV1(env.PHOTO_STORAGE_SERVICE_KEY, async () => { throw new PhotoWriteErrorV1('invalid'); });
  const images = await readAvatarBatchV1(batch.subjects, {
    families: subjects => repository.avatarFamilies(subjects),
    read: (asset, signal) => storage.read(asset, signal),
    authorize: async () => {
      request.signal.throwIfAborted();
      const current = await requirePagesContextV1(request, env, false, traceId);
      if (current.actorId.toLowerCase() !== initial.actorId.toLowerCase() || current.tenantId !== initial.tenantId)
        throw new AccessDenied(403);
    },
  }, request.signal);
  try {
    const body = encodePhotoAvatarBatchV1(images);
    return new Response(body.buffer as ArrayBuffer, { headers: { ...privateHeaders,
      'Content-Type': PHOTO_AVATAR_BATCH_TYPE_V1, 'Content-Length': String(body.length) } });
  } finally { for (const item of images) if (item instanceof Uint8Array) item.fill(0); }
}

/** One image: the WebP, or (authorized again) the colored circle for a missing avatar, or 404. */
async function serveImageV1(
  service: ReturnType<typeof createPhotoRuntimeServiceV1>,
  context: PhotoWriteContextV1,
  parsedImage: NonNullable<ReturnType<typeof readImageQuery>>,
  authorize: (candidate: PhotoWriteContextV1) => Promise<void>,
  signal: AbortSignal,
) {
  const bytes = await service.catalog.read(context, parsedImage.variant, parsedImage.revision, signal);
  if (!bytes) {
    await authorize(context);
    if (parsedImage.variant === 'avatar') {
      // A server-derived color keeps the same person's fallback identical across modules.
      const hue = photoFallbackHueV1(context.studentUid);
      return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="hsl(${hue},48%,44%)"/></svg>`, {
        headers: { ...privateHeaders, 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; sandbox" },
      });
    }
    return new Response(null, { status: 404, headers: privateHeaders });
  }
  try {
    return new Response(new Uint8Array(bytes).buffer, { headers: { ...privateHeaders,
      'Content-Type': 'image/webp', 'Content-Length': String(bytes.length) } });
  } finally { bytes.fill(0); }
}

/** A failure as the client reads it; an image failure is also logged with its storage reason. */
function photoFailureV1(error: unknown, image: boolean, signal: AbortSignal, traceId: string) {
  if (image && error instanceof Error) {
    const reason = /^student-photo-storage-[a-z-]+(?:-\d{3})?$/u.test(error.message)
      ? error.message : error.name;
    console.error('student-photo-image-unavailable', reason);
  }
  if (error instanceof AccessDenied) return json({ state: error.status === 401 ? 'unauthenticated' : 'forbidden', traceId }, error.status);
  if (error instanceof PhotoTransportReadErrorV1) return json({ state: error.code, traceId }, error.code === 'too-large' ? 413 : 400);
  if (error instanceof PhotoWriteErrorV1) return json({ state: error.code, traceId }, error.code === 'not-found' ? 404 : 409);
  if (error instanceof z.ZodError) return json({ state: 'invalid', traceId }, 400);
  return json({ state: signal.aborted ? 'cancelled' : 'unavailable', traceId }, 503);
}

/** Actual Pages integration. No Graph/privileged services are exposed to the student worker. */
export async function servePhotoRuntimeV1(request: Request, env: RuntimeEnv, codec: StudentWebpCodecV1): Promise<Response> {
  const traceId = crypto.randomUUID(), url = new URL(request.url), path = url.pathname;
  const editPath = path === PHOTO_ADMIN_PATHS_V1.preview || path === PHOTO_ADMIN_PATHS_V1.save;
  const image = path === paths.image;
  if (!editPath && !Object.values(paths).includes(path)) return json({ state: 'not-found', traceId }, 404);
  if (!requestAllowed(request, env, image)) return json({ state: 'forbidden', traceId }, 403);
  const write = editPath || path === paths.open || path === paths.recover;
  let connection: Awaited<ReturnType<typeof openPhotoDatabaseV1>> | undefined;
  try {
    // Authenticate before opening a database connection or receiving any image bytes.
    const initial = await requirePagesContextV1(request, env, write, traceId);
    request.signal.throwIfAborted();
    connection = await openPhotoDatabaseV1(env);
    const repository = new PhotoCatalogRepositoryV1(connection.database);
    if (editPath) return await servePhotoAdminV1(request, env, {
      enabled: true,
      resolveSubject: async (_admin, subject, signal) => { signal.throwIfAborted(); return repository.resolve(subject); },
      createService: authorize => createPhotoRuntimeServiceV1({ env, database: connection!.database, codec, authorize }).edit,
    });
    if (path === paths.avatars) return await serveAvatarBatchV1(request, env, repository, initial, traceId);
    const parsedImage = image ? readImageQuery(url) : null;
    const raw: unknown = image ? null : await readPhotoJsonV1(request, request.signal);
    const input = image ? null : photoRequestInputV1(path, raw);
    const subject: PhotoAdminSubjectV1 = parsedImage?.subject ?? input!.subject;
    const context = photoWriteContextV1.parse({ actorId: initial.actorId, studentUid: await repository.resolve(subject) });
    const authorize = async (candidate: PhotoWriteContextV1) => {
      request.signal.throwIfAborted();
      const current = await requirePagesContextV1(request, env, write, traceId);
      if (current.actorId.toLowerCase() !== context.actorId || current.tenantId !== initial.tenantId
        || candidate.actorId !== context.actorId || candidate.studentUid !== context.studentUid
        || await repository.resolve(subject) !== context.studentUid) throw new AccessDenied(403);
      request.signal.throwIfAborted();
    };
    // The image read authorizes before the catalog and again after Storage; repeating either
    // check back to back only added database round trips to every avatar.
    if (!parsedImage) await authorize(context);
    const service = createPhotoRuntimeServiceV1({ env, database: connection.database, codec, authorize });
    if (parsedImage) return await serveImageV1(service, context, parsedImage, authorize, request.signal);
    if (path === paths.recover) {
      const requestId = recoverRequest.parse(input).requestId;
      const result = await service.recover(context, requestId, request.signal);
      return json({ version: 1, traceId, ...result }, result.state === 'pending' ? 202 : 200);
    }
    const catalog = path === paths.open
      ? await service.catalog.open(context, request.signal) : await repository.state(context);
    await authorize(context);
    const canWrite = await mayWriteV1(request, env, traceId, { actorId: context.actorId, tenantId: initial.tenantId });
    return json({ version: 1, state: 'catalog', traceId, canWrite, catalog });
  } catch (error) {
    return photoFailureV1(error, image, request.signal, traceId);
  } finally {
    // Closing a connection after a committed mutation cannot invalidate its receipt.
    await connection?.close().catch(() => undefined);
  }
}
