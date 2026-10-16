// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { collectorLeaseExpiryV1, readCollectorOwnDirectoryV1 } from '../../server/collector/directory-v1';
import type { CollectorGrantBindingV1 } from '../../server/collector/refresh-cipher-v1';

const now = Date.parse('2026-10-13T23:40:35Z');
const binding: CollectorGrantBindingV1 = { tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333',
  grantId: '44444444-4444-4444-8444-444444444444', generation: 1, version: 2, originAuthenticatedAt: now - 3600_000 };
const group = '55555555-5555-4555-8555-555555555555';
const token = { token_type: 'Bearer', access_token: 'synthetic-only-access-token', refresh_token: 'synthetic-new-refresh-token',
  expires_in: 3600, scope: 'User.Read' };
const me = { id: binding.actorId, accountEnabled: true, signInSessionsValidFromDateTime: new Date(now-7200_000).toISOString() };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup(responses = [json(token), json(me), json({ value: [group] })], clock = () => now) {
  const queue = [...responses];
  const fetcher = vi.fn(async () => queue.shift() ?? json({}, 503));
  return { binding, expectedTenantId: binding.tenantId, expectedClientId: binding.clientId,
    adminGroupId: group, refreshToken: 'synthetic-only-original-refresh-token',
    dependencies: { fetch: fetcher as unknown as typeof fetch, now: clock,
      clientAssertion: async () => 'synthetic-server-client-assertion' }, fetcher };
}

describe('collector own-user delegation only', () => {
  it('pins tenant/client/scope and calls only me and the fixed admin group', async () => {
    const input = setup(); const result = await readCollectorOwnDirectoryV1(input);
    expect(result.evidence.directoryCheckedAt).toBe(now);
    expect(result.evidence.directoryValidUntil).toBe(now+300_000);
    expect(result.evidence.originAuthenticatedAt).toBe(binding.originAuthenticatedAt);
    expect(result.nextRefreshToken).toBe(token.refresh_token);
    const calls = input.fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual([
      `https://login.microsoftonline.com/${binding.tenantId}/oauth2/v2.0/token`,
      'https://graph.microsoft.com/v1.0/me?$select=id,accountEnabled,signInSessionsValidFromDateTime',
      'https://graph.microsoft.com/v1.0/me/checkMemberGroups']);
    expect(String(calls[0]![1].body)).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2FUser.Read');
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ groupIds: [group] });
    expect(calls.every(call => call[1].redirect === 'manual')).toBe(true);
  });
  it('does not turn an almost expired directory check into five new minutes', async () => {
    const { evidence } = await readCollectorOwnDirectoryV1(setup());
    expect(collectorLeaseExpiryV1(binding, evidence, now+299_000)).toBe(now+300_000);
    expect(() => collectorLeaseExpiryV1(binding, evidence, now+300_000)).toThrow('access-denied');
    expect(() => collectorLeaseExpiryV1({ ...binding, generation: 2 }, evidence, now)).toThrow('access-denied');
    expect(() => collectorLeaseExpiryV1({ ...binding, actorId: group }, evidence, now)).toThrow('access-denied');
  });
  it.each([false, null, undefined])('denies accountEnabled=%s', async accountEnabled => {
    await expect(readCollectorOwnDirectoryV1(setup([json(token), json({ ...me, accountEnabled })]))).rejects.toThrow();
  });
  it.each([null, undefined, 'not-a-date'])('denies missing/malformed revocation marker %s', async marker => {
    await expect(readCollectorOwnDirectoryV1(setup([json(token), json({ ...me, signInSessionsValidFromDateTime: marker })]))).rejects.toThrow();
  });
  it('denies account swap, new revocation and missing group without resetting origin time', async () => {
    for (const value of [{ ...me, id: group }, { ...me, signInSessionsValidFromDateTime: new Date(now).toISOString() }])
      await expect(readCollectorOwnDirectoryV1(setup([json(token), json(value)]))).rejects.toThrow('access-denied');
    await expect(readCollectorOwnDirectoryV1(setup([json(token), json(me), json({ value: [] })]))).rejects.toThrow('access-denied');
  });
  it.each([400, 401, 403])('denies token response %s without alternative identity or secret echo', async status => {
    const input = setup([json({ error: 'invalid_grant', private: 'do-not-echo-token' }, status)]);
    await expect(readCollectorOwnDirectoryV1(input)).rejects.toThrow('reauthentication-required');
    expect(input.fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts the sign-in scopes Entra returns beside User.Read, never a broader Graph permission', async () => {
    const signIn = 'openid profile email offline_access https://graph.microsoft.com/User.Read';
    const input = setup([json({ ...token, scope: signIn }), json(me), json({ value: [group] })]);
    await expect(readCollectorOwnDirectoryV1(input)).resolves.toMatchObject({ nextRefreshToken: token.refresh_token });
    for (const scope of ['openid profile email', 'openid User.Read GroupMember.Read.All', 'https://graph.microsoft.com/.default'])
      await expect(readCollectorOwnDirectoryV1(setup([json({ ...token, scope })]))).rejects.toThrow('invalid-contract');
  });
  it('rejects broad/default scope, foreign grant and API redirects', async () => {
    await expect(readCollectorOwnDirectoryV1(setup([json({ ...token, scope: 'User.Read Directory.Read.All' })]))).rejects.toThrow();
    const input = setup(); input.expectedClientId = group;
    await expect(readCollectorOwnDirectoryV1(input)).rejects.toThrow('access-denied');
    expect(input.fetcher).not.toHaveBeenCalled();
    await expect(readCollectorOwnDirectoryV1(setup([json(token), new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } })]))).rejects.toThrow();
  });
  it('blocks Graph outage after the old evidence expires and overly slow fresh proof', async () => {
    await expect(readCollectorOwnDirectoryV1(setup([json(token), json({}, 503)]))).rejects.toThrow('unavailable');
    let calls = 0;
    await expect(readCollectorOwnDirectoryV1(setup(undefined, () => calls++ === 0 ? now : now+300_000))).rejects.toThrow('access-denied');
  });
  it('retains the current refresh if Microsoft returns no replacement, not falsely one-use', async () => {
    const withoutReplacement = { token_type: token.token_type, access_token: token.access_token,
      expires_in: token.expires_in, scope: token.scope };
    const input = setup([json(withoutReplacement), json(me), json({ value: [group] })]);
    expect((await readCollectorOwnDirectoryV1(input)).nextRefreshToken).toBe(input.refreshToken);
  });
});
