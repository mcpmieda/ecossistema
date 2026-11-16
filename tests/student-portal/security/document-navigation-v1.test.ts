import { describe, expect, it } from 'vitest';
import {
  portalDocumentNavigationAllowedV1,
  portalRequestOriginAllowedV1,
} from '../../../server/student-portal/runtime/http-v1';

const origin = 'https://aluno.escolaieda.com';
const opens = (path: string, headers?: HeadersInit) =>
  portalDocumentNavigationAllowedV1(new Request(origin + path, { headers }), 'production', origin);

describe('opening the Portal page from links (students reported 403)', () => {
  it('opens from links in other sites and apps, with tracking parameters', () => {
    expect(opens('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' })).toBe(true);
    expect(opens('/?fbclid=abc123', { 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(opens('/?utm_source=whatsapp&utm_medium=social')).toBe(true);
    expect(opens('/access', { 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(opens('/', { 'sec-fetch-site': 'none' })).toBe(true);
  });

  it('still refuses framing, forged hosts and other paths', () => {
    expect(opens('/', { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(opens('/', { host: 'attacker.invalid' })).toBe(false);
    expect(opens('/', { 'x-forwarded-host': 'attacker.invalid' })).toBe(false);
    expect(opens('/', { origin: 'https://attacker.invalid' })).toBe(false);
    expect(opens('/api/student/me', { 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(
      portalDocumentNavigationAllowedV1(new Request('https://evil.invalid/'), 'production', origin),
    ).toBe(false);
    expect(portalDocumentNavigationAllowedV1(new Request(origin + '/'), 'preview', origin)).toBe(
      false,
    );
  });

  it('keeps the strict rule for every API call', () => {
    const api = (headers: HeadersInit) =>
      portalRequestOriginAllowedV1(
        new Request(origin + '/api/student/me', { headers }),
        'production',
        origin,
      );
    expect(api({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(api({ 'sec-fetch-site': 'same-origin' })).toBe(true);
  });
});
