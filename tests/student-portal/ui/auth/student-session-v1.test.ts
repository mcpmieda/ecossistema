// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudentSessionV1,
  type LogoutStateV1,
} from '../../../../src/features/student-portal/auth/student-session-v1';
import type { PortalLoadStateV1 } from '../../../../src/features/student-portal/shared/latest-request-v1';
import { PortalClientErrorV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { SYNTHETIC_SELF_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import { clientFixtureV1, NOW, SESSION } from './fixtures-v1';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
function setup() {
  const client = clientFixtureV1(),
    publish = vi.fn<(s: PortalLoadStateV1<SelfResponseV1>) => void>(),
    logoutState = vi.fn<(s: LogoutStateV1) => void>();
  const session = createStudentSessionV1(client, publish, logoutState);
  return { client, publish, logoutState, session, state: () => publish.mock.lastCall![0] };
}
describe('student session revalidation and data clearing', () => {
  it('preserves a valid snapshot while revalidating and expires even if that request stalls', async () => {
    const s = setup();
    s.client.session.mockResolvedValueOnce({
      ...SESSION,
      expiresAt: new Date(NOW + 2000).toISOString(),
    });
    await s.session.refresh();
    const ready = s.state();
    let resolve!: (value: typeof SESSION) => void;
    s.client.session.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = s.session.refresh(true);
    const duplicate = s.session.refresh(true);
    expect(s.state()).toBe(ready);
    expect(s.client.session).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.state()).toMatchObject({ state: 'error', error: { state: 'unauthenticated' } });
    resolve(SESSION);
    await Promise.all([pending, duplicate]);
    expect(s.state().state).toBe('error');
    expect(s.client.me).toHaveBeenCalledTimes(1);
    s.session.dispose();
  });
  it('rejects an account change during background revalidation instead of mixing student state', async () => {
    const s = setup();
    await s.session.refresh();
    s.client.me.mockResolvedValueOnce({
      ...SYNTHETIC_SELF_V1,
      profile: {
        ...SYNTHETIC_SELF_V1.profile,
        accountId: '00000000-0000-4000-8000-000000000099',
      },
    });
    await s.session.refresh(true);
    expect(s.state()).toMatchObject({ state: 'error', error: { state: 'unauthenticated' } });
    s.session.dispose();
  });
  it('validates session before self and replaces the old payload immediately on refresh', async () => {
    const s = setup();
    await s.session.refresh();
    expect(s.state()).toEqual({ state: 'ready', data: SYNTHETIC_SELF_V1 });
    expect(s.client.session.mock.invocationCallOrder[0]).toBeLessThan(
      s.client.me.mock.invocationCallOrder[0]!,
    );
    const refresh = s.session.refresh();
    expect(s.state()).toEqual({ state: 'loading' });
    await refresh;
    s.session.dispose();
  });
  it('does not fetch self after an unauthorized session', async () => {
    const s = setup();
    s.client.session.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    await s.session.refresh();
    expect(s.client.me).not.toHaveBeenCalled();
    expect(s.state().state).toBe('error');
    s.session.dispose();
  });
  it('drops protected data and preserves an access closure received during reauthorization', async () => {
    const s = setup();
    await s.session.refresh();
    s.client.session.mockRejectedValueOnce(new PortalClientErrorV1('access-closed', 403));
    await expect(s.session.authorizeSecurity(new AbortController().signal)).rejects.toMatchObject({ state: 'access-closed' });
    expect(s.state()).toMatchObject({ state: 'error', error: { state: 'access-closed' } });
    expect(s.client.me).toHaveBeenCalledTimes(1);
    s.session.dispose();
  });
  it('clears immediately on logout and cannot restore a late self response', async () => {
    const s = setup();
    let resolve!: (v: SelfResponseV1) => void;
    s.client.me.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const refresh = s.session.refresh();
    await Promise.resolve();
    const logout = s.session.logout();
    expect(s.state()).toEqual({ state: 'idle' });
    resolve(SYNTHETIC_SELF_V1);
    await Promise.all([logout, refresh]);
    expect(s.state().state).toBe('error');
    expect(s.logoutState.mock.lastCall?.[0]).toBe('done');
    s.session.dispose();
  });
  it('keeps data blocked after uncertain logout until the explicit retry commits', async () => {
    const s = setup();
    await s.session.refresh();
    s.client.logout.mockRejectedValueOnce(new Error('network'));
    await s.session.logout();
    expect(s.logoutState.mock.lastCall?.[0]).toBe('failed');
    await s.session.refresh();
    expect(s.client.session).toHaveBeenCalledOnce();
    expect(s.state().state).toBe('error');
    await s.session.logout();
    expect(s.logoutState.mock.lastCall?.[0]).toBe('done');
    await s.session.authenticated();
    expect(s.state().state).toBe('ready');
    s.session.dispose();
  });
  it('expires the protected DOM at the server deadline without adding an inactivity timeout', async () => {
    const s = setup();
    s.client.session.mockResolvedValueOnce({
      ...SESSION,
      expiresAt: new Date(NOW + 2000).toISOString(),
    });
    await s.session.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.state().state).toBe('error');
    s.session.dispose();
  });
  it('supports a 30-day deadline beyond the browser timer integer limit', async () => {
    const s = setup(),
      lifetime = 30 * 86400000;
    s.client.session.mockResolvedValueOnce({
      ...SESSION,
      expiresAt: new Date(NOW + lifetime).toISOString(),
    });
    await s.session.refresh();
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(s.state().state).toBe('ready');
    await vi.advanceTimersByTimeAsync(lifetime - 2147483647);
    expect(s.state().state).toBe('error');
    s.session.dispose();
  });
  it('discards in-flight work on suspension/disposal even when abort is ignored', async () => {
    const s = setup();
    let resolve!: (v: SelfResponseV1) => void;
    s.client.me.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const refresh = s.session.refresh();
    await Promise.resolve();
    s.session.clear();
    s.session.dispose();
    const calls = s.publish.mock.calls.length;
    resolve(SYNTHETIC_SELF_V1);
    await refresh;
    expect(s.publish.mock.calls).toHaveLength(calls);
    expect(s.state()).toEqual({ state: 'idle' });
  });
});
