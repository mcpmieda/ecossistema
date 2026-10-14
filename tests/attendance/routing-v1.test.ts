// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { onRequest as administrativeRequest } from '../../functions/[[path]]';
import { onRequest as portalRequest } from '../../workers/student-portal/edge/[[path]]';
import type { RuntimeEnv } from '../../server/env';
import { testEnv } from '../fixtures';

const origin = testEnv.OFFICIAL_ORIGIN;
const paths = ['/api/attendance/v1', '/api/attendance/v1/', '/api/attendance%2Fv1'];

describe('attendance candidate remains unmounted in actual entry points', () => {
  it.each(paths)('ADM rejects %s without fetching assets or a database', async (path) => {
    const assets = vi.fn(async () => new Response('SYNTHETIC ASSET'));
    for (const method of ['GET', 'POST']) {
      const request = new Request(origin + path, { method, headers: { Origin: origin } });
      const response = await administrativeRequest({
        request,
        env: { ...testEnv, ASSETS: { fetch: assets } } as unknown as RuntimeEnv,
      } as never);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.text()).not.toContain('attendance-v1');
    }
    expect(assets).not.toHaveBeenCalled();
  });
  it.each(['/api/attendance/v1', '/api/attendance/v1/'])(
    'Portal rejects %s without forwarding to self or assets',
    async (path) => {
      const fetch = vi.fn(async () => new Response('SYNTHETIC RESPONSE'));
      for (const method of ['GET', 'POST']) {
        const portalOrigin = 'https://aluno.escolaieda.com';
        const request = new Request(portalOrigin + path, {
          method,
          headers: { Origin: portalOrigin },
        });
        const response = await portalRequest({
          request,
          env: {
            PORTAL_ENVIRONMENT: 'production',
            PORTAL_ORIGIN: portalOrigin,
            ASSETS: { fetch },
            PORTAL_SELF: { fetch },
          },
        } as never);
        expect(response.status).toBe(404);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.text()).not.toContain('attendance-v1');
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
