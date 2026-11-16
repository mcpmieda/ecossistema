// @vitest-environment node
import { expect, it } from 'vitest';
import {
  createAccountMutationV1,
  type AccountMutationStateV1,
} from '../../../src/features/student-portal-admin/accounts/account-mutation-v1';
import { accountCommandV1 } from '../../../src/features/student-portal-admin/accounts/accounts-values-v1';
import { accountJsonV1, accountsMockV1, ACCOUNT_META_V1 } from '../ui/accounts/fixtures-v1';
import { qrPrintCardsV1 } from '../qr-print/fixtures-v1';

it.each(['offered', 'unavailable'] as const)(
  'announces preparation until QR rendering actually settles as %s without repeating the committed action',
  async (outcome) => {
    const mock = accountsMockV1({
      write: async (command) =>
        accountJsonV1({
          ...ACCOUNT_META_V1,
          state: 'qr',
          version: 10,
          cards: [{ ...qrPrintCardsV1(1, 'qr-only')[0]!, accountId: 'accountId' in command ? command.accountId : '' }],
        }),
    });
    const states: AccountMutationStateV1[] = [];
    let resolve!: () => void, reject!: (error: Error) => void;
    const render = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const writer = createAccountMutationV1(
      mock.props.client,
      mock.accounts[0]!.accountId,
      (state) => states.push(state),
      () => render,
    );
    const pending = writer.submit(accountCommandV1(mock.accounts[0]!, 'qr-regenerate'));
    // Wait on the actual handoff stage, not a delay tied to machine speed.
    await new Promise<void>((done, fail) => {
      const deadline = Date.now() + 2000;
      const observe = () => {
        if (states.some((s) => s.state === 'committed')) done();
        else if (Date.now() > deadline) fail(new Error('Synthetic render not reached'));
        else setTimeout(observe, 1);
      };
      observe();
    });
    expect(states.at(-1)).toMatchObject({ state: 'committed', artifact: 'preparing' });
    await writer.retry();
    expect(mock.writes).toHaveLength(1);
    if (outcome === 'offered') resolve();
    else reject(new Error('Synthetic bitmap failure'));
    await pending;
    expect(states.at(-1)).toMatchObject({ state: 'committed', artifact: outcome });
    expect(mock.writes).toHaveLength(1);
    writer.clear();
  },
);
