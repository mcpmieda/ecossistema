// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '../../../server/auth/roles';
import { AuthenticationError } from '../../../server/auth/session';
import type { RuntimeEnv } from '../../../server/env';
import { createPerformanceRequestHandlerV1 } from '../../../server/gradebook/http/performance-routes-v1';

const ORIGIN = 'https://preview.pages.dev';
const env = { OFFICIAL_ORIGIN: ORIGIN } as RuntimeEnv;
function request(body: unknown): Request {
  return new Request(`${ORIGIN}/api/gradebook/performance`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}


function handler() {
  return createPerformanceRequestHandlerV1({ async authorizeRequest() {
    return { runtimeAuthorization: {} as never, capabilities: ['platform.settings.read'] };
  } });
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
describe('Performance HTTP V1 retirement', () => {
  it.each([AuthenticationError, AuthorizationError])('preserves %s before storage access', async (ErrorType) => {
    const access = vi.fn(() => { throw new Error('retired-storage-access'); });
    const guarded = Object.defineProperty({ ...env }, 'GRADEBOOK_DATABASE', { get: access });
    const route = createPerformanceRequestHandlerV1({ async authorizeRequest() { throw new ErrorType(); } });
    const response = await route(request({ transportVersion: 1, operation: 'matrix' }), guarded);
    expect(response?.status).toBe(new ErrorType().status);
    expect(response?.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate, private');
    await expect(response?.json()).resolves.toEqual({ transportVersion: 1, state: 'not-authorized' });
    expect(access).not.toHaveBeenCalled();
  });
  it('mantém dispatch explícito e gate fail-closed para transportes V2 a V6', async () => {
    const route = handler();
    const validCurrentRequests = [
      { transportVersion: 2, operation: 'classes', year: 2026, offset: 0, limit: 100 },
      {
        transportVersion: 3,
        operation: 'analysis',
        year: 2026,
        classId: 10,
        period: 1,
        mode: 'regular',
        statuses: [null, 7],
        lens: 'result',
        offerId: null,
      },
      {
        transportVersion: 4,
        operation: 'term-comparison',
        year: 2026,
        classId: 10,
        period: 3,
        referencePeriod: 1,
        mode: 'regular',
        statuses: [null, 7],
        lens: 'result',
        offerId: null,
      },
      {
        transportVersion: 5,
        operation: 'dashboard',
        year: 2026,
        classId: 10,
        period: 1,
        referencePeriod: null,
        mode: 'regular',
        statuses: [null, 7],
        lens: 'result',
        offerId: null,
      },
      {
        transportVersion: 6,
        operation: 'analytics',
        year: 2026,
        classId: 10,
        period: 1,
      },
    ] as const;

    for (const value of validCurrentRequests) {
      const response = await route(request(value), env);
      expect(response?.status).toBe(503);
      expect(await json(response as Response)).toEqual({
        transportVersion: value.transportVersion,
        state: 'unavailable',
      });
    }

    for (const transportVersion of [2, 3, 4, 5, 6] as const) {
      const response = await route(request({ transportVersion }), env);
      expect(response?.status).toBe(400);
      expect(await json(response as Response)).toEqual({
        transportVersion,
        state: 'invalid-request',
      });
    }
  });


  it('retires every old version without reading it or touching storage', async () => {
    const access = vi.fn(() => { throw new Error('retired-storage-access'); });
    const guarded = Object.defineProperties({ ...env }, {
      GRADEBOOK_D1: { get: access }, GRADEBOOK_DATABASE: { get: access }, PROD_DB: { get: access },
    });
    const route = handler();
    for (const body of [{ transportVersion: 1, operation: 'matrix' }, { transportVersion: 1, operation: 'cell-detail', detailRef: 'x' }, { bad: true }]) {
      const response = await route(request(body), guarded);
      expect(response?.status).toBe(410);
      expect(response?.headers.get('Cache-Control')).toContain('no-store');
      await expect(response?.json()).resolves.toEqual({ state: 'retired' });
    }
    for (const body of [[1], 'text', null]) {
      expect((await route(request(body), guarded))?.status).toBe(400);
    }
    expect(access).not.toHaveBeenCalled();
  });
});
