// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  diagnoseCloudflarePortalDeployV1,
  diagnoseCloudflarePortalHyperdriveV1,
  probeCloudflareCapabilitiesV1,
} from '../scripts/cloudflare-operator-v1';

const ACCOUNT = 'a'.repeat(32);
const NOW = new Date('2026-09-20T16:00:00.000Z');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Cloudflare read-only operator', () => {
  it('fails before network access when the account selector is invalid', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      probeCloudflareCapabilitiesV1({
        accountId: 'invalid',
        token: 'secret',
        tokenKind: 'deploy',
        fetcher,
        now: NOW,
      }),
    ).rejects.toThrow('Invalid Cloudflare account selector');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a missing existing credential without making requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await probeCloudflareCapabilitiesV1({
      accountId: ACCOUNT,
      token: '',
      tokenKind: 'hyperdrive',
      fetcher,
      now: NOW,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.capabilities).toHaveLength(5);
    expect(result.capabilities.every((item) => item.state === 'credential-missing')).toBe(true);
  });

  it('probes only the fixed read/query allowlist and sanitizes provider outcomes', async () => {
    const token = 'synthetic-super-secret-token';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/workers/scripts')) return json({ success: true, result: [] });
      if (url.includes('/pages/projects')) return json({ success: false }, 403);
      if (url.includes('/hyperdrive/configs')) return json({ success: false }, 500);
      if (url.includes('/zones?'))
        return json({ success: false, errors: [{ message: 'private' }] });
      if (url.endsWith('/graphql'))
        return json({ data: { viewer: { accounts: [] } }, errors: null });
      throw new Error('Unexpected URL');
    });

    const result = await probeCloudflareCapabilitiesV1({
      accountId: ACCOUNT,
      token,
      tokenKind: 'deploy',
      fetcher,
      now: NOW,
    });

    expect(result.capabilities.map(({ id, state }) => [id, state])).toEqual([
      ['workers.scripts.read', 'accessible'],
      ['pages.projects.read', 'permission-required'],
      ['hyperdrive.configs.read', 'unavailable'],
      ['zones.read', 'inconclusive'],
      ['analytics.workers.read', 'accessible'],
    ]);
    expect(calls).toHaveLength(5);
    for (const call of calls.slice(0, 4)) expect(call.init?.method).toBe('GET');
    expect(calls[4]?.init?.method).toBe('POST');
    const graphqlBody = JSON.parse(String(calls[4]?.init?.body));
    expect(graphqlBody.query).toContain('query CapabilityProbe');
    expect(graphqlBody.query).not.toContain('mutation');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('treats GraphQL application errors as inconclusive instead of requesting a new token', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/graphql')) return json({ data: null, errors: [{ message: 'denied' }] });
      return json({ success: true, result: [] });
    });
    const result = await probeCloudflareCapabilitiesV1({
      accountId: ACCOUNT,
      token: 'synthetic',
      tokenKind: 'deploy',
      fetcher,
      now: NOW,
    });
    expect(result.capabilities.find((item) => item.id === 'analytics.workers.read')?.state).toBe(
      'inconclusive',
    );
  });

  it('maps transport failures to unavailable without exposing the error', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('provider secret diagnostic');
    });
    const result = await probeCloudflareCapabilitiesV1({
      accountId: ACCOUNT,
      token: 'synthetic',
      tokenKind: 'deploy',
      fetcher,
      now: NOW,
    });
    expect(result.capabilities.every((item) => item.state === 'unavailable')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('provider secret diagnostic');
  });

  it('returns a fixed sanitized Portal deployment diagnostic without downloading Worker source', async () => {
    const token = 'synthetic-deploy-secret';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/workers/scripts')) {
        return json({
          success: true,
          result: [
            {
              id: 'student-portal-production',
              modified_on: '2026-09-20T15:00:00.000Z',
              compatibility_date: '2026-09-01',
              bindings: [{ name: 'PRIVATE_SECRET', secret_text: 'never-output' }],
            },
          ],
        });
      }
      if (url.endsWith('/pages/projects/student-portal-edge')) {
        return json({
          success: true,
          result: {
            name: 'student-portal-edge',
            production_branch: 'main',
            domains: ['private-preview.example'],
            canonical_deployment: {
              created_on: '2026-09-20T15:05:00.000Z',
              latest_stage: { status: 'success', name: 'deploy' },
              env_vars: { SECRET: { value: 'never-output' } },
            },
          },
        });
      }
      if (url.endsWith('/graphql')) {
        return json({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      sum: { requests: 12, errors: 1 },
                      quantiles: { cpuTimeP50: 3, cpuTimeP99: 9 },
                    },
                    {
                      sum: { requests: 8, errors: 0 },
                      quantiles: { cpuTimeP50: 4, cpuTimeP99: 7 },
                    },
                  ],
                },
              ],
            },
          },
          errors: null,
        });
      }
      throw new Error('Unexpected URL');
    });

    const result = await diagnoseCloudflarePortalDeployV1({
      accountId: ACCOUNT,
      token,
      fetcher,
      now: NOW,
    });

    expect(result.worker).toEqual({
      state: 'accessible',
      present: true,
      modifiedAt: '2026-09-20T15:00:00.000Z',
      compatibilityDate: '2026-09-01',
    });
    expect(result.pages).toEqual({
      state: 'accessible',
      present: true,
      productionBranch: 'main',
      deploymentStatus: 'success',
      deploymentCreatedAt: '2026-09-20T15:05:00.000Z',
    });
    expect(result.analytics).toEqual({
      state: 'accessible',
      windowMinutes: 60,
      requests: 20,
      errors: 1,
      maxCpuTimeP50: 4,
      maxCpuTimeP99: 9,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toMatch(/\/workers\/scripts$/u);
    expect(calls[1]?.url).toMatch(/\/pages\/projects\/student-portal-edge$/u);
    expect(calls[2]?.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[1]?.init?.method).toBe('GET');
    expect(calls[2]?.init?.method).toBe('POST');
    const query = JSON.parse(String(calls[2]?.init?.body));
    expect(query.query).toContain('query PortalWorkerMetrics');
    expect(query.query).toContain('cpuTimeP50');
    expect(query.query).toContain('cpuTimeP99');
    expect(query.query).not.toContain('mutation');
    expect(query.variables.scriptName).toBe('student-portal-production');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('never-output');
    expect(JSON.stringify(result)).not.toContain('private-preview.example');
  });

  it('returns only bounded Hyperdrive health fields and strips origin details', async () => {
    const token = 'synthetic-hyperdrive-secret';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      return json({
        success: true,
        result: {
          id: '46ac2fcb25ad4ad5b5662d536ccd968a',
          caching: { disabled: true, max_age: 60 },
          origin_connection_limit: 8,
          origin: {
            host: 'database.private.example',
            database: 'postgres',
            user: 'student_portal_app',
            password: 'never-output',
          },
        },
      });
    });

    const result = await diagnoseCloudflarePortalHyperdriveV1({
      accountId: ACCOUNT,
      token,
      fetcher,
      now: NOW,
    });

    expect(result.hyperdrive).toEqual({
      state: 'accessible',
      present: true,
      cacheDisabled: true,
      originConnections: 8,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/hyperdrive\/configs\/46ac2fcb25ad4ad5b5662d536ccd968a$/u);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('database.private.example');
    expect(JSON.stringify(result)).not.toContain('student_portal_app');
    expect(JSON.stringify(result)).not.toContain('never-output');
  });

  it('distinguishes a missing fixed Portal resource without treating it as a permission request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    const result = await diagnoseCloudflarePortalHyperdriveV1({
      accountId: ACCOUNT,
      token: 'synthetic',
      fetcher,
      now: NOW,
    });
    expect(result.hyperdrive).toEqual({ state: 'not-found', present: false });
  });
});
