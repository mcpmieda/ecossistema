// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import {
  createSettingsMutationV1,
  type SettingsCommandV1,
  type SettingsMutationStateV1,
} from '../../../../src/features/student-portal-admin/settings/settings-mutation-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
const command = (): SettingsCommandV1 => ({
  contractVersion: 1,
  operation: 'settings-set',
  scope: { kind: 'school', academicYear: 2026 },
  expectedVersion: 4,
  idempotencyKey: SYNTHETIC_ID_V1,
  value: { accessEnabled: false, allowedPeriods: [] },
  acknowledgeImmediateEffect: true,
});
const response = (state: 'committed' | 'conflict' | 'rate-limited', status = 200) =>
  new Response(
    JSON.stringify({
      contractVersion: 1,
      requestId: SYNTHETIC_ID_V1,
      state,
      ...(state === 'committed'
        ? { operationId: SYNTHETIC_ID_V1, version: 5 }
        : state === 'rate-limited'
          ? { retryAfterSeconds: 2 }
          : {}),
    }),
    { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
describe('settings mutation receipts and scope disposal', () => {
  it('retries identical bytes, version and key after a lost response even if the original object changes', async () => {
    const bodies: string[] = [],
      states: SettingsMutationStateV1[] = [];
    const client = createPortalAdminClientV1({
      fetch: async (_path, init) => {
        bodies.push(String(init.body));
        if (bodies.length <= 2) throw new Error('synthetic lost response');
        return response('committed');
      },
    });
    const mutation = createSettingsMutationV1(client, (state) => states.push(state));
    const input = command();
    await mutation.submit(input);
    expect(states.at(-1)).toMatchObject({ state: 'error', retryable: true });
    if (input.operation === 'settings-set') input.value.accessEnabled = true;
    await mutation.retry();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[2]!)).toMatchObject({
      expectedVersion: 4,
      value: { accessEnabled: false, allowedPeriods: [] },
    });
    expect(states.at(-1)).toEqual({ state: 'committed', version: 5 });
  });
  it('does not silently change CAS or retry a conflict', async () => {
    const fetch = vi.fn(async () => response('conflict', 409));
    const states: SettingsMutationStateV1[] = [];
    const mutation = createSettingsMutationV1(createPortalAdminClientV1({ fetch }), (state) =>
      states.push(state),
    );
    await mutation.submit(command());
    await mutation.retry();
    expect(fetch).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({
      state: 'error',
      retryable: false,
      error: { state: 'conflict' },
    });
  });
  it('honors the server retry interval without changing the pending intention', async () => {
    let clock = 1000;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response('rate-limited', 429))
      .mockResolvedValueOnce(response('committed'));
    const states: SettingsMutationStateV1[] = [];
    const mutation = createSettingsMutationV1(
      createPortalAdminClientV1({ fetch }),
      (state) => states.push(state),
      () => clock,
    );
    await mutation.submit(command());
    expect(states.at(-1)).toMatchObject({ retryAt: 3000 });
    await mutation.retry();
    expect(fetch).toHaveBeenCalledOnce();
    clock = 3000;
    await mutation.retry();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not publish success after the owning scope unmounts even when fetch ignores abort', async () => {
    let complete!: (value: Response) => void;
    const states: SettingsMutationStateV1[] = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const mutation = createSettingsMutationV1(createPortalAdminClientV1({ fetch }), (state) =>
      states.push(state),
    );
    const pending = mutation.submit(command());
    await mutation.submit(command());
    expect(fetch).toHaveBeenCalledOnce();
    mutation.dispose();
    complete(response('committed'));
    await pending;
    expect(states).toEqual([{ state: 'pending' }]);
    await mutation.retry();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not dispatch a reset or any other administrative command through settings', async () => {
    const fetch = vi.fn();
    const mutation = createSettingsMutationV1(createPortalAdminClientV1({ fetch }), vi.fn());
    await expect(mutation.submit({ operation: 'account-reset' } as never)).rejects.toMatchObject({
      state: 'invalid-request',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
