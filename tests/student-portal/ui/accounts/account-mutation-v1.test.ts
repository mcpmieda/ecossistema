// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createAccountMutationV1,
  type AccountMutationStateV1,
} from '../../../../src/features/student-portal-admin/accounts/account-mutation-v1';
import { accountCommandV1 } from '../../../../src/features/student-portal-admin/accounts/accounts-values-v1';
import { accountJsonV1, accountsMockV1, ACCOUNT_META_V1, accountIdV1 } from './fixtures-v1';

describe('account command lifecycle', () => {
  it('keeps captured bytes on uncertain retry and blocks duplicate pending sends', async () => {
    const resolves: Array<(response: Response) => void> = [];
    const mock = accountsMockV1({
      write: () =>
        new Promise((done) => {
          resolves.push(done);
        }),
    });
    const states: AccountMutationStateV1[] = [];
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
    );
    const command = accountCommandV1(mock.accounts[0]!, 'password-reset');
    const pending = writer.submit(command);
    await writer.submit(command);
    expect(mock.writes).toHaveLength(1);
    command.expectedVersion = 90;
    resolves[0]!(accountJsonV1({ ...ACCOUNT_META_V1, state: 'unavailable' }, 503));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(2));
    resolves[1]!(accountJsonV1({ ...ACCOUNT_META_V1, state: 'unavailable' }, 503));
    await pending;
    expect(states.at(-1)).toMatchObject({ state: 'error', retryable: true });
    const retry = writer.retry();
    await vi.waitFor(() => expect(mock.writes).toHaveLength(3));
    resolves[2]!(
      accountJsonV1({
        ...ACCOUNT_META_V1,
        state: 'committed',
        operationId: accountIdV1(9001),
        version: 10,
      }),
    );
    await retry;
    expect(new Set(mock.bodies).size).toBe(1);
    expect(states.at(-1)).toMatchObject({ state: 'committed' });
    writer.clear();
  });
  it('honors Retry-After and never promotes a conflicting CAS', async () => {
    let now = 1000;
    const mock = accountsMockV1({
      write: async () =>
        accountJsonV1({ ...ACCOUNT_META_V1, state: 'rate-limited', retryAfterSeconds: 5 }, 429),
    });
    const states: AccountMutationStateV1[] = [];
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
      undefined,
      () => now,
    );
    await writer.submit(accountCommandV1(mock.accounts[0]!, 'block'));
    await writer.retry();
    expect(mock.writes).toHaveLength(1);
    now += 5000;
    await writer.retry();
    expect(mock.writes).toHaveLength(2);
    writer.clear();
    const conflict = accountsMockV1({
      write: async () => accountJsonV1({ ...ACCOUNT_META_V1, state: 'conflict' }, 409),
    });
    const second = createAccountMutationV1(
      conflict.props.client,
      conflict.accounts[0]!.accountId,
      (state) => states.push(state),
    );
    await second.submit(accountCommandV1(conflict.accounts[0]!, 'block'));
    await second.retry();
    expect(conflict.writes).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      state: 'error',
      retryable: false,
      error: { state: 'conflict' },
    });
  });
  it('discards a late commit after selection change and is reusable after cleanup', async () => {
    let resolve!: (response: Response) => void;
    const mock = accountsMockV1({
      write: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const states: AccountMutationStateV1[] = [];
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
    );
    const command = accountCommandV1(mock.accounts[0]!, 'block');
    const pending = writer.submit(command);
    writer.clear();
    resolve(
      accountJsonV1({
        ...ACCOUNT_META_V1,
        state: 'committed',
        operationId: accountIdV1(9001),
        version: 10,
      }),
    );
    await pending;
    expect(states.at(-1)).toEqual({ state: 'idle' });
    const next = writer.submit(command);
    resolve(
      accountJsonV1({
        ...ACCOUNT_META_V1,
        state: 'committed',
        operationId: accountIdV1(9001),
        version: 10,
      }),
    );
    await next;
    expect(states.at(-1)).toMatchObject({ state: 'committed' });
  });
  it('hands QR only to its private callback and treats artifact failure as already committed', async () => {
    const mock = accountsMockV1(),
      states: AccountMutationStateV1[] = [];
    const onQr = vi.fn(async () => {
      throw new Error('Synthetic artifact unavailable');
    });
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
      onQr,
    );
    await writer.submit(accountCommandV1(mock.accounts[0]!, 'qr-regenerate'));
    expect(onQr).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ state: 'committed', artifact: 'unavailable' });
    expect(JSON.stringify(states)).not.toContain('/access#');
    await writer.retry();
    expect(mock.writes).toHaveLength(1);
  });
  it('rejects commands for another account and refuses protected failures without retry', async () => {
    const mock = accountsMockV1({
      write: async () => accountJsonV1({ ...ACCOUNT_META_V1, state: 'forbidden' }, 403),
    });
    const states: AccountMutationStateV1[] = [];
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
    );
    await expect(writer.submit(accountCommandV1(mock.accounts[1]!, 'block'))).rejects.toThrow();
    expect(mock.writes).toHaveLength(0);
    await writer.submit(accountCommandV1(mock.accounts[0]!, 'block'));
    await writer.retry();
    expect(states.at(-1)).toMatchObject({ state: 'error', retryable: false });
    expect(mock.writes).toHaveLength(1);
  });
});
