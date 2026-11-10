import { describe, expect, it } from 'vitest';
import { accountFixtureV1, accountPageV1, ACCOUNT_CLASS_V1 } from './fixtures-v1';
import {
  ACCOUNT_ACTIONS_V1,
  accountCommandV1,
  accountLinkLabelV1,
  accountManageableV1,
  accountPageMatchesV1,
  lastAuthenticationLabelV1,
} from '../../../../src/features/student-portal-admin/accounts/accounts-values-v1';
describe('account presentation decisions', () => {
  it('distinguishes Portal closure, missing, ambiguous and exit without rewriting academic identity', () => {
    const account = accountFixtureV1();
    expect(accountLinkLabelV1({ ...account, linkClosed: true })).toBe('Encerrado no Portal');
    expect(accountLinkLabelV1({ ...account, link: null })).toBe('Sem vínculo acadêmico');
    expect(accountLinkLabelV1({ ...account, eligibility: 'unresolved' })).toBe(
      'Não resolvido',
    );
    expect(accountLinkLabelV1({ ...account, eligibility: 'exit' })).toBe('Saída da escola');
    for (const item of [
      { ...account, linkClosed: true },
      { ...account, link: null },
      { ...account, classId: null },
    ])
      expect(accountManageableV1(item)).toBe(false);
    expect(() => accountCommandV1({ ...account, linkClosed: true }, 'block')).toThrow();
  });
  it('captures independent security intentions and account CAS without academic mutation', () => {
    const account = accountFixtureV1();
    const reset = accountCommandV1(account, 'account-reset');
    expect(reset).toMatchObject({
      accountId: account.accountId,
      expectedVersion: 9,
      operation: 'account-reset',
      confirmed: true,
    });
    expect(accountCommandV1(account, 'password-reset').operation).toBe('password-reset');
    expect(accountCommandV1(account, 'qr-regenerate').operation).toBe('qr-regenerate');
    expect(accountCommandV1(account, 'unblock')).toMatchObject({
      operation: 'block',
      blocked: false,
    });
    expect(ACCOUNT_ACTIONS_V1.unblock.description).toContain('Não remove o bloqueio temporário');
    account.version++;
    expect(reset.expectedVersion).toBe(9);
  });
  it('never turns missing retained authentication into never and rejects wrong identities', () => {
    expect(lastAuthenticationLabelV1(null)).toBe('Nenhum em 12 meses');
    expect(lastAuthenticationLabelV1('2026-09-13T15:00:00Z')).toContain('12:00');
    const account = accountFixtureV1();
    expect(() =>
      accountPageMatchesV1(accountPageV1([account, account]), ACCOUNT_CLASS_V1),
    ).toThrow();
    expect(() =>
      accountPageMatchesV1(accountPageV1([account]), { ...ACCOUNT_CLASS_V1, classId: 753002 }),
    ).toThrow();
  });
});
