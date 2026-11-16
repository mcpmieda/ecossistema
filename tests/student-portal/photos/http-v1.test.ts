// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  servePortalPhotoV1,
  type OwnPortraitReaderV1,
} from '../../../server/student-portal/photos/http-v1';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import {
  portraitContentPathV1,
  portraitMetadataV1,
  STUDENT_PHOTO_META_PATH_V1,
} from '../../../shared/student-photos/portrait-v1';
import { storedPortraitBytesV1 } from '../../../server/student-portal/photos/read-v1';
import {
  photoMetadataFixtureV1 as metadata,
  photoRevisionFixtureV1 as revision,
  syntheticWebpV1,
  syntheticPhotoHashV1,
} from './fixture-v1';

const cookie = '__Host-student_portal_session=' + 'a'.repeat(43);
const origin = 'https://aluno.escolaieda.com';
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: origin,
  PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001',
  PORTAL_SERVING_ENABLED: 'true',
  PORTAL_PHOTOS_ENABLED: 'true',
  PORTAL_AUTH_GLOBAL: { limit: vi.fn().mockResolvedValue({ success: true }) },
};
const request = (path = STUDENT_PHOTO_META_PATH_V1, init: RequestInit = {}) =>
  new Request(origin + path, {
    headers: { origin, cookie, 'sec-fetch-site': 'same-origin' },
    ...init,
  });
const privateResponse = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.has('location')).toBe(false);
};

describe('private photo route', () => {
  it('is mounted on the real self entrypoint but defaults closed without keys or a database', async () => {
    const disabled = { ...env, PORTAL_PHOTOS_ENABLED: undefined };
    const response = await servePortalSelfV1(request(), disabled);
    expect(response.status).toBe(204);
    privateResponse(response);
    const content = await servePortalSelfV1(request(portraitContentPathV1(revision)), disabled);
    expect(content.status).toBe(404);
    privateResponse(content);
  });
  it('returns only minimal metadata and a versioned own-origin path', async () => {
    const read = vi.fn<OwnPortraitReaderV1>().mockResolvedValue({ state: 'metadata', metadata });
    const response = await servePortalPhotoV1(request(), env, read);
    expect(response.status).toBe(200);
    privateResponse(response);
    expect(await response.json()).toEqual(metadata);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toBeNull();
    expect(portraitContentPathV1(revision)).toBe('/api/student/photo/content?v=' + revision);
    expect(
      portraitMetadataV1.safeParse({ ...metadata, url: 'https://storage.invalid/private' }).success,
    ).toBe(false);
  });
  it('authorizes again for content and does not turn conditional headers into an unauthenticated 304', async () => {
    const read = vi
      .fn<OwnPortraitReaderV1>()
      .mockResolvedValue({ state: 'content', metadata, bytes: syntheticWebpV1() });
    const response = await servePortalPhotoV1(
      request(portraitContentPathV1(revision), {
        headers: {
          origin,
          cookie,
          'if-none-match': '*',
          'if-modified-since': new Date().toUTCString(),
        },
      }),
      env,
      read,
    );
    expect(response.status).toBe(200);
    privateResponse(response);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(syntheticWebpV1());
    expect(read.mock.calls[0]?.[1]).toBe(revision);
  });
  it.each([
    // Disallowed queries are refused by the outer security boundary, before routing.
    ['/api/student/photo?studentUid=123', 'GET', 403],
    ['/api/student/photo?accountId=123', 'GET', 403],
    ['/api/student/photo/content', 'GET', 400],
    ['/api/student/photo/content?v=bad', 'GET', 403],
    [portraitContentPathV1(revision) + '&v=' + revision, 'GET', 403],
    [portraitContentPathV1(revision) + '&studentUid=123', 'GET', 403],
    ['/api/student/photo', 'POST', 405],
    ['/api/student/photo', 'HEAD', 405],
    ['/api/student/photo/other', 'GET', 404],
  ])('refuses %s (%s) before opening the reader', async (path, method, status) => {
    const read = vi.fn<OwnPortraitReaderV1>();
    const response = await servePortalPhotoV1(request(path, { method }), env, read);
    expect(response.status).toBe(status);
    privateResponse(response);
    expect(read).not.toHaveBeenCalled();
  });
  it('refuses foreign origin, range requests and maintenance without touching storage', async () => {
    const read = vi.fn<OwnPortraitReaderV1>();
    expect(
      (
        await servePortalPhotoV1(
          request(undefined, { headers: { origin: 'https://other.invalid' } }),
          env,
          read,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await servePortalPhotoV1(
          request(undefined, { headers: { origin, cookie, range: 'bytes=0-10' } }),
          env,
          read,
        )
      ).status,
    ).toBe(400);
    expect(
      (await servePortalPhotoV1(request(), { ...env, PORTAL_SERVING_ENABLED: 'false' }, read))
        .status,
    ).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps absent media, rejected sessions and storage failures distinct, with no sensitive response body', async () => {
    for (const state of ['absent', 'unauthenticated', 'failed'] as const) {
      const read: OwnPortraitReaderV1 = async () => {
        if (state === 'failed') throw new Error('SYNTHETIC PRIVATE DRIVER DETAIL');
        return state === 'absent' ? { state: 'absent' } : null;
      };
      const response = await servePortalPhotoV1(request(), env, read);
      expect(response.status).toBe(
        state === 'absent' ? 204 : state === 'unauthenticated' ? 401 : 503,
      );
      privateResponse(response);
      expect(await response.text()).toBe('');
    }
  });
  it('checks stored bytes and checksum without claiming to implement upload decoding', () => {
    expect(storedPortraitBytesV1(syntheticWebpV1(), syntheticPhotoHashV1)).toEqual(
      syntheticWebpV1(),
    );
    const changed = syntheticWebpV1();
    changed[30] = changed[30]! ^ 1;
    for (const bytes of [
      changed,
      new Uint8Array(131073),
      new Uint8Array(10),
      new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
    ])
      expect(() => storedPortraitBytesV1(bytes, syntheticPhotoHashV1)).toThrow();
    expect(() => storedPortraitBytesV1(syntheticWebpV1(), '0'.repeat(64))).toThrow();
  });
});
