// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  collectorLeaseExpiryV1,
  readCollectorDirectoryV1,
  type CollectorGrantBindingV1,
} from '../../server/collector/directory-v1';
import { GraphError } from '../../server/graph/request-policy-v1';

const now = Date.parse('2026-10-13T23:40:35Z');
const binding: CollectorGrantBindingV1 = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  actorId: '33333333-3333-4333-8333-333333333333',
  grantId: '44444444-4444-4444-8444-444444444444',
  generation: 1,
  version: 2,
  originAuthenticatedAt: now - 3600_000,
};
const group = '55555555-5555-4555-8555-555555555555';
const user = {
  id: binding.actorId,
  accountEnabled: true,
  signInSessionsValidFromDateTime: new Date(now - 7200_000).toISOString(),
};
type Answer = unknown | (() => unknown);
function setup(answers: Answer[] = [user, { value: [group] }], clock = () => now) {
  const queue = [...answers];
  const graph = vi.fn(async (_input: { path: string; method?: string; body?: unknown }) => {
    const answer = queue.shift();
    return typeof answer === 'function' ? (answer as () => unknown)() : answer;
  });
  return {
    binding,
    expectedTenantId: binding.tenantId,
    expectedClientId: binding.clientId,
    adminGroupId: group,
    dependencies: { now: clock, graph },
    graph,
  };
}
const refusal = (status: number) => () => {
  throw new GraphError(status, 'synthetic-correlation');
};

describe('the collector person, read in the directory by the server itself', () => {
  it('reads only that account and the fixed admin group, and keeps the origin time', async () => {
    const input = setup();
    const evidence = await readCollectorDirectoryV1(input);
    expect(evidence.directoryCheckedAt).toBe(now);
    expect(evidence.directoryValidUntil).toBe(now + 300_000);
    expect(evidence.originAuthenticatedAt).toBe(binding.originAuthenticatedAt);
    expect(input.graph.mock.calls.map(([call]) => call)).toEqual([
      {
        path: `/users/${binding.actorId}?$select=id,accountEnabled,signInSessionsValidFromDateTime`,
      },
      {
        path: `/users/${binding.actorId}/checkMemberGroups`,
        method: 'POST',
        body: { groupIds: [group] },
      },
    ]);
  });
  it('does not turn an almost expired directory check into five new minutes', async () => {
    const evidence = await readCollectorDirectoryV1(setup());
    expect(collectorLeaseExpiryV1(binding, evidence, now + 299_000)).toBe(now + 300_000);
    expect(() => collectorLeaseExpiryV1(binding, evidence, now + 300_000)).toThrow('access-denied');
    expect(() => collectorLeaseExpiryV1(binding, evidence, now + 1000, 300_001)).toThrow(
      'access-denied',
    );
  });
  it.each([
    ['a disabled account', [{ ...user, accountEnabled: false }, { value: [group] }]],
    ['another account', [{ ...user, id: '66666666-6666-4666-8666-666666666666' }]],
    [
      'sign-ins revoked after the grant was authorized',
      [{ ...user, signInSessionsValidFromDateTime: new Date(now - 60_000).toISOString() }],
    ],
    ['an account that left the admin group', [user, { value: [] }]],
    ['an answer naming another group', [user, { value: ['77777777-7777-4777-8777-777777777777'] }]],
    ['an account Entra no longer has', [refusal(404)]],
  ] satisfies Array<[string, Answer[]]>)('denies %s', async (_name, answers) => {
    await expect(readCollectorDirectoryV1(setup(answers))).rejects.toMatchObject({
      reason: 'access-denied',
    });
  });
  it('denies a grant of another tenant or client before any directory read', async () => {
    for (const other of [
      { expectedTenantId: '88888888-8888-4888-8888-888888888888' },
      { expectedClientId: '88888888-8888-4888-8888-888888888888' },
    ]) {
      const input = setup();
      await expect(readCollectorDirectoryV1({ ...input, ...other })).rejects.toMatchObject({
        reason: 'access-denied',
      });
      expect(input.graph).not.toHaveBeenCalled();
    }
  });
  // An outage ends no grant: only the directory's own answer does.
  it.each([
    ['Graph is down', [refusal(503)]],
    ['Graph throttles', [refusal(429)]],
    ['the server identity is refused', [refusal(401)]],
    ['the server identity lacks the permission', [refusal(403)]],
    ['the membership read fails', [user, refusal(503)]],
    ['the membership read finds no account (it existed a moment ago)', [user, refusal(404)]],
    ['the account answer is malformed', [{ id: binding.actorId }]],
    [
      'the revocation marker is not a date',
      [{ ...user, signInSessionsValidFromDateTime: 'not-a-date' }],
    ],
    ['accountEnabled is missing', [{ ...user, accountEnabled: null }]],
    ['the membership answer is malformed', [user, { value: 'all' }]],
    ['the membership answer lists more than was asked', [user, { value: [group, group] }]],
  ] satisfies Array<[string, Answer[]]>)('is unavailable when %s', async (_name, answers) => {
    await expect(readCollectorDirectoryV1(setup(answers))).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
  it('refuses a proof that took longer than its own window', async () => {
    let clock = now;
    const input = setup(
      [
        user,
        () => {
          clock = now + 300_000;
          return { value: [group] };
        },
      ],
      () => clock,
    );
    await expect(readCollectorDirectoryV1(input)).rejects.toMatchObject({
      reason: 'access-denied',
    });
  });
  it('logs the failed stage and nothing of the person or the provider', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(readCollectorDirectoryV1(setup([refusal(503)]))).rejects.toThrow();
    expect(log.mock.calls).toEqual([
      [JSON.stringify({ message: 'collector_directory_failed', stage: 'read-user' })],
    ]);
    log.mockRestore();
  });
});
