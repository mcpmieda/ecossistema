import { STUDENT_PHOTO_META_PATH_V1, STUDENT_PHOTO_CONTENT_PATH_V1,
  photoRevisionV1 } from '../../../shared/student-photos/portrait-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';
import { checkPortalAnonymousV1 } from '../observability/anonymous-peer-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from '../composition/config-v1';
import { portalDatabaseV1 } from '../composition/database-v1';
import { readOwnPortraitV1, type PortraitReadV1 } from './read-v1';
import { PhotoStorageV1, PHOTO_BUCKET_V1 } from '../../student-photos/storage-v1';

type PhotoEnvV1 = PortalCompositionEnvV1 & { PORTAL_PHOTOS_ENABLED?: string };
export type OwnPortraitReaderV1 = (token: string, revision: string | null) => Promise<PortraitReadV1 | null>;
type PhotoTargetV1 = { kind: 'metadata'; revision: null } | { kind: 'content'; revision: string };
type PhotoValidationV1 = { target: PhotoTargetV1 } | { error: Response };

function reply(status: number, body: BodyInit | null = null, type?: string): Response {
  const headers = new Headers({ 'Cache-Control': 'private, no-store', 'Vary': 'Cookie',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer' });
  if (type) headers.set('Content-Type', type);
  return new Response(body, { status, headers });
}

/** Validation order is intentional: origin, path, method, range and exact query before keys/SQL. */
function validatePhotoRequestV1(request: Request, env: PhotoEnvV1): PhotoValidationV1 {
  if (!portalRequestOriginAllowedV1(request, env.PORTAL_ENVIRONMENT, env.PORTAL_ORIGIN))
    return { error: reply(403) };
  const url = new URL(request.url);
  const content = url.pathname === STUDENT_PHOTO_CONTENT_PATH_V1;
  if (!content && url.pathname !== STUDENT_PHOTO_META_PATH_V1) return { error: reply(404) };
  if (request.method !== 'GET') return { error: reply(405) };
  if (request.headers.has('range')) return { error: reply(400) };
  const entries = [...url.searchParams];
  if (!content && entries.length === 0) return { target: { kind: 'metadata', revision: null } };
  if (!content) return { error: reply(400) };
  const revision = photoRevisionV1.safeParse(url.searchParams.get('v'));
  if (entries.length !== 1 || entries[0]?.[0] !== 'v' || !revision.success) return { error: reply(400) };
  return { target: { kind: 'content', revision: revision.data } };
}

function photoReadResponseV1(result: PortraitReadV1 | null, target: PhotoTargetV1): Response {
  if (result === null) return reply(401);
  if (result.state === 'absent') return reply(target.kind === 'content' ? 404 : 204);
  if (target.kind === 'metadata' && result.state === 'metadata')
    return reply(200, JSON.stringify(result.metadata), 'application/json; charset=utf-8');
  if (target.kind === 'content' && result.state === 'content') {
    const bytes = new Uint8Array(result.bytes.byteLength); bytes.set(result.bytes);
    return reply(200, bytes.buffer, 'image/webp');
  }
  return reply(503);
}

/** No redirect, conditional 304, range request or caller-selected student. Every success is authorized. */
export async function servePortalPhotoV1(request: Request, env: PhotoEnvV1,
  read: OwnPortraitReaderV1 = (token, revision) => portalDatabaseV1(env, 'self', sql =>
    readOwnPortraitV1(sql, portalKeysV1(env).cryptoPort, token, revision, async object => {
      const storage = new PhotoStorageV1(env.PHOTO_STORAGE_SERVICE_KEY, async () => {
        throw new Error('student-photo-storage-write-forbidden');
      });
      return storage.read({ driveId: PHOTO_BUCKET_V1, itemId: object.path, etag: object.sha256,
        sha256: object.sha256, byteSize: object.byteSize, width: object.width, height: object.height }, request.signal);
    }, accountId => checkPortalOperationV1(env.PORTAL_PHOTO_ACCOUNT, 'photo', accountId)))): Promise<Response> {
  const validation = validatePhotoRequestV1(request, env);
  if ('error' in validation) return validation.error;
  if (env.PORTAL_SERVING_ENABLED !== 'true') return reply(503);
  // Explicitly disabled until the reviewed migration, publisher and image-use authorization exist.
  if (env.PORTAL_PHOTOS_ENABLED !== 'true') return reply(validation.target.kind === 'content' ? 404 : 204);
  try {
    const token = sessionCookieTokenV1(request);
    if (!token) return reply(401);
    await checkPortalAnonymousV1(env, 'photo-entry', request);
    const result = await read(token, validation.target.revision);
    return photoReadResponseV1(result, validation.target);
  } catch (error) {
    if (error instanceof PortalRateLimitErrorV1 && error.state === 'rate-limited') {
      const response = reply(429); response.headers.set('Retry-After', String(error.retryAfterSeconds)); return response;
    }
    // No driver details, request cookies, student identity, source locators or image data in logs.
    return reply(503);
  }
}
