// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudentAuthFlowV1,
  type StudentAuthStateV1,
} from '../../../../src/features/student-portal/auth/auth-flow-v1';
import { SYNTHETIC_QR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { PortalClientErrorV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { clientFixtureV1, NOW, PROOF, REQUIRED, SESSION } from './fixtures-v1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
function setup() {
  const client = clientFixtureV1(),
    publish = vi.fn<(s: StudentAuthStateV1) => void>(),
    success = vi.fn();
  const flow = createStudentAuthFlowV1(client, publish, success);
  return { client, flow, publish, success, state: () => publish.mock.lastCall![0] };
}
describe('student authentication state machine', () => {
  it('shows a closed access message without treating it as a wrong credential', async () => {
    const s = setup();
    s.client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('access-closed', 403));
    await s.flow.begin(SYNTHETIC_QR_V1);
    expect(s.state()).toMatchObject({ step: 'scan', message: 'Acesso ao Portal fechado.' });
    expect(s.success).not.toHaveBeenCalled();
    s.flow.dispose();
  });
  it('lets the server choose PIN, creates a one-use password and sends explicit false', async () => {
    const s = setup();
    await s.flow.begin(SYNTHETIC_QR_V1);
    expect(s.state().step).toBe('pin');
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.pin('0001');
    expect(s.state().step).toBe('create');
    await s.flow.activate('001234', '001234', false);
    expect(s.client.activate.mock.calls[0]?.[0]).toMatchObject({
      password: '001234',
      confirmation: '001234',
      keepConnected: false,
    });
    expect(s.success).toHaveBeenCalledOnce();
    expect(s.state().step).toBe('authenticated');
    await s.flow.activate('001234', '001234', true);
    expect(s.client.activate).toHaveBeenCalledOnce();
    const visible = JSON.stringify(s.publish.mock.calls);
    expect(visible).not.toContain(SYNTHETIC_QR_V1);
    expect(visible).not.toContain(PROOF.challenge);
    expect(visible).not.toContain('001234');
    s.flow.dispose();
  });
  it('rejects non-ASCII/short PIN and mismatched passwords before requesting', async () => {
    const s = setup();
    await s.flow.begin(SYNTHETIC_QR_V1);
    await s.flow.pin('１２３４');
    await s.flow.pin('123');
    expect(s.client.challenge).toHaveBeenCalledOnce();
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.pin('0001');
    await s.flow.activate('482913', '482914', true);
    expect(s.client.activate).not.toHaveBeenCalled();
    s.flow.dispose();
  });
  it('expires a proof and cannot use it after the deadline', async () => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.begin(SYNTHETIC_QR_V1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(s.state().step).toBe('scan');
    await s.flow.activate('001234', '001234', true);
    expect(s.client.activate).not.toHaveBeenCalled();
    s.flow.dispose();
  });
  it('keeps a fresh proof on a phone whose clock runs ahead of the server and lets the server decide', async () => {
    vi.setSystemTime(NOW + 6 * 60_000);
    const s = setup();
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.pin('0001');
    expect(s.state().step).toBe('create');
    await vi.advanceTimersByTimeAsync(599_999);
    expect(s.state().step).toBe('create');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state()).toMatchObject({
      step: 'scan',
      message: 'O prazo para criar a senha terminou. Leia o QR novamente.',
    });
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.begin(SYNTHETIC_QR_V1);
    await s.flow.activate('482913', '482913', false);
    expect(s.client.activate).toHaveBeenCalledOnce();
    s.flow.dispose();
  });
  it('confirms a committed activation with the chosen password when its response was lost', async () => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.activate.mockRejectedValueOnce(new PortalClientErrorV1('network-error'));
    await s.flow.activate('001234', '001234', true);
    expect(s.state().step).toBe('authenticated');
    expect(s.client.activate).toHaveBeenCalledOnce();
    expect(s.client.login).toHaveBeenCalledOnce();
    expect(s.client.login.mock.calls[0]?.[0]).toMatchObject({
      qr: SYNTHETIC_QR_V1,
      password: '001234',
      keepConnected: true,
    });
    expect(s.success).toHaveBeenCalledOnce();
    s.flow.dispose();
  });
  it('retries activation only after login proves that the first request did not commit', async () => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.activate
      .mockRejectedValueOnce(new PortalClientErrorV1('unavailable', 503))
      .mockResolvedValueOnce(SESSION);
    s.client.login.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    await s.flow.activate('001234', '001234', false);
    expect(s.client.activate).toHaveBeenCalledTimes(2);
    expect(s.client.activate.mock.calls[0]?.[0]).toEqual(s.client.activate.mock.calls[1]?.[0]);
    expect(s.client.login).toHaveBeenCalledOnce();
    expect(s.state().step).toBe('authenticated');
    expect(s.success).toHaveBeenCalledOnce();
    s.flow.dispose();
  });
  it('uses a fresh risk token for the actual password attempt, never the discovery token', async () => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(REQUIRED('risk'));
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.challenge.mockResolvedValueOnce(REQUIRED('password'));
    await s.flow.risk('synthetic-discovery-token');
    expect(s.state()).toMatchObject({ step: 'password', needsRisk: true });
    await s.flow.login('001234', true);
    expect(s.client.login).not.toHaveBeenCalled();
    await s.flow.login('001234', true, 'synthetic-fresh-token');
    expect(s.client.login.mock.calls[0]?.[0]).toMatchObject({
      riskToken: 'synthetic-fresh-token',
      keepConnected: true,
    });
    s.flow.dispose();
  });
  it('rediscovers reset/risk after a failed password instead of inferring account status', async () => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(REQUIRED('password'));
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.login.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    s.client.challenge.mockResolvedValueOnce(REQUIRED('risk'));
    await s.flow.login('001234', true);
    expect(s.state()).toMatchObject({ step: 'risk', needsRisk: true });
    expect(s.success).not.toHaveBeenCalled();
    s.flow.dispose();
  });
  it('honors server retry-after without submitting during the block', async () => {
    const s = setup();
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('rate-limited', 429, 30));
    await s.flow.pin('0001');
    await s.flow.pin('0001');
    expect(s.client.challenge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    await s.flow.pin('0001');
    expect(s.client.challenge).toHaveBeenCalledTimes(3);
    s.flow.dispose();
  });
  it('ignores a response after cancellation even if the client ignores abort', async () => {
    const s = setup();
    let resolve!: (v: ReturnType<typeof REQUIRED>) => void;
    s.client.challenge.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = s.flow.begin(SYNTHETIC_QR_V1);
    s.flow.reset();
    resolve(REQUIRED('password'));
    await pending;
    expect(s.state().step).toBe('scan');
    s.flow.dispose();
  });
  it('ignores an old QR response after replacing the current QR', async () => {
    const s = setup();
    let resolve!: (v: ReturnType<typeof REQUIRED>) => void;
    s.client.challenge.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = s.flow.begin(SYNTHETIC_QR_V1);
    await s.flow.begin(SYNTHETIC_QR_V1.replace('v1.a', 'v1.c'));
    resolve(REQUIRED('password'));
    await first;
    expect(s.state().step).toBe('pin');
    s.flow.dispose();
  });
});

it('discards a revoked QR after a stale password screen and never resubmits the old credential', async () => {
  const s = setup();
  s.client.challenge.mockResolvedValueOnce(REQUIRED('password'));
  await s.flow.begin(SYNTHETIC_QR_V1);
  s.client.login.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
  s.client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
  await s.flow.login('001234', false);
  expect(s.state()).toMatchObject({ step: 'scan', needsRisk: false });
  expect(s.state().message).toContain('Leia o cartão atual');
  await s.flow.login('001234', false);
  expect(s.client.login).toHaveBeenCalledOnce();
  expect(s.success).not.toHaveBeenCalled();
  s.client.challenge.mockResolvedValueOnce(REQUIRED('pin'));
  await s.flow.begin(SYNTHETIC_QR_V1);
  expect(s.state().step).toBe('pin');
  s.flow.dispose();
});

it.each([
  ['unavailable', 'O serviço de acesso está temporariamente indisponível'],
  ['network-error', 'Não foi possível conectar'],
] as const)(
  'distinguishes %s from invalid credentials without replaying login',
  async (code, message) => {
    const s = setup();
    s.client.challenge.mockResolvedValueOnce(REQUIRED('password'));
    await s.flow.begin(SYNTHETIC_QR_V1);
    s.client.login.mockRejectedValueOnce(new PortalClientErrorV1(code));
    await s.flow.login('001234', false);
    expect(s.state()).toMatchObject({ step: 'password' });
    expect(s.state().message).toContain(message);
    expect(s.client.login).toHaveBeenCalledOnce();
    expect(s.client.challenge).toHaveBeenCalledOnce();
    s.flow.dispose();
  },
);
