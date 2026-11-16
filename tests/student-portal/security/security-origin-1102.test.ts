// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { portalRequestOriginAllowedV1 } from '../../../server/student-portal/runtime/http-v1';

const origin = 'https://aluno.escolaieda.com';
const account = '11111111-1111-4111-8111-111111111111';
const allowed = (path: string, headers?: HeadersInit) =>
  portalRequestOriginAllowedV1(new Request(origin + path, { headers }), 'production', origin);

describe('security query allowlist #1102', () => {
  it('permits only account-bound session and security socket parameters', () => {
    expect(allowed(`/api/student/session?accountId=${account}`)).toBe(true);
    expect(allowed(`/api/student/session?accountId=${account}&connectionId=${account}`)).toBe(true);
    expect(
      allowed(`/api/student/live?purpose=security&accountId=${account}&connectionId=${account}`),
    ).toBe(true);
    expect(allowed(`/api/student/live?purpose=security&accountId=${account}`)).toBe(true);
    expect(allowed('/api/student/session')).toBe(true);
    expect(allowed('/api/student/live')).toBe(true);
    for (const path of [
      `/api/student/me?accountId=${account}`,
      `/api/student/session?accountId=${account}&extra=1`,
      `/api/student/session?accountId=${account}&accountId=${account}`,
      `/api/student/live?purpose=academic&accountId=${account}`,
      `/api/student/live?purpose=security&purpose=security&accountId=${account}`,
      '/api/student/live?purpose=security',
      '/api/student/session?accountId=invalid',
      `/api/student/session?connectionId=${account}`,
      `/api/student/session?accountId=${account}&connectionId=invalid`,
      `/api/student/session?accountId=${account}&connectionId=${account}&connectionId=${account}`,
    ])
      expect(allowed(path)).toBe(false);
  });

  it('preserves origin, host and fetch-site defenses for allowed security queries', () => {
    const path = `/api/student/live?purpose=security&accountId=${account}`;
    const rejectedHeaders: HeadersInit[] = [
      { origin: 'https://attacker.invalid' },
      { host: 'attacker.invalid' },
      { 'x-forwarded-host': 'attacker.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of rejectedHeaders) expect(allowed(path, headers)).toBe(false);
  });
});
