// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { portalRequestOriginAllowedV1 } from '../../../server/student-portal/runtime/http-v1';
import { servePortalSelfV1 } from '../../../server/student-portal/composition/self-v1';
import { portraitContentPathV1 } from '../../../shared/student-photos/portrait-v1';
import { photoRevisionFixtureV1 as revision, photoAccountV1 } from './fixture-v1';

const origin = 'https://aluno.escolaieda.com';
const photoPath = portraitContentPathV1(revision);
const request = (path: string, headers: HeadersInit = {}) =>
  new Request(origin + path, { headers });
const allowed = (path: string, headers: HeadersInit = {}) =>
  portalRequestOriginAllowedV1(request(path, headers), 'production', origin);

describe('photo query integration in the existing Portal origin boundary', () => {
  it('accepts the exact versioned photo URL without changing session/live queries', () => {
    expect(allowed(photoPath)).toBe(true);
    expect(allowed(photoPath, { origin, 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(allowed('/api/student/session?accountId=' + photoAccountV1)).toBe(true);
    expect(allowed('/api/student/live?accountId=' + photoAccountV1 + '&purpose=security')).toBe(
      true,
    );
  });

  it.each([
    '/api/student/photo?v=' + revision,
    '/api/student/photo?accountId=' + photoAccountV1,
    '/api/student/photo/content?v=',
    '/api/student/photo/content?v=bad',
    photoPath + '&v=' + revision,
    photoPath + '&accountId=' + photoAccountV1,
    photoPath + '&studentUid=' + photoAccountV1,
    photoPath + '&purpose=security',
    photoPath + '&url=https%3A%2F%2Fforeign.invalid%2Fimage.webp',
    '/api/student/photo/content/?v=' + revision,
    '/api/student/me?v=' + revision,
    '/api/student/session?v=' + revision,
    '/api/student/session?accountId=' + photoAccountV1 + '&v=' + revision,
    '/api/student/live?accountId=' + photoAccountV1 + '&purpose=security&v=' + revision,
  ])('rejects unauthorized query/path combination %s at the real outer boundary', async (path) => {
    expect(allowed(path)).toBe(false);
    // No keys/database configured. Routing must reject before trying either.
    const response = await servePortalSelfV1(request(path), {
      PORTAL_ENVIRONMENT: 'production',
      PORTAL_ORIGIN: origin,
      PORTAL_SERVING_ENABLED: 'true',
      PORTAL_ADMIN_TENANT_ID: '50000000-0000-4000-8000-000000000001',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it.each([
    ['origin', 'https://foreign.invalid'],
    ['host', 'foreign.invalid'],
    ['sec-fetch-site', 'cross-site'],
    ['sec-fetch-site', 'same-site'],
    ['x-forwarded-host', 'foreign.invalid'],
    ['x-original-url', photoPath],
  ])('does not weaken %s protection for a valid revision (%s)', (name, value) => {
    expect(allowed(photoPath, { [name]: value })).toBe(false);
  });

  it('keeps preview environments and foreign request origins closed', () => {
    expect(portalRequestOriginAllowedV1(request(photoPath), 'preview', origin)).toBe(false);
    expect(
      portalRequestOriginAllowedV1(
        new Request('https://foreign.invalid' + photoPath),
        'production',
        origin,
      ),
    ).toBe(false);
  });
});
