import { describe, expect, it } from 'vitest';
import { adminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { readBirthPageV1 } from '../../../../src/features/student-portal-admin/birth-year/birth-read-v1';
import { birthYearV1 } from '../../../../shared/student-portal-contracts/admin-v1';
const validBirthYearV1 = (value: string) => birthYearV1.safeParse(value).success;
import { BIRTH_CLASS_V1, birthMockV1, birthJsonV1 } from './fixtures-v1';

describe('birth values and bounded joined reads', () => {
  it('reuses the record account only after the authorized birth read confirms its version', async () => {
    const mock = birthMockV1();
    const account = mock.accounts[0]!;
    const scope = {
      kind: 'account' as const,
      academicYear: 2026 as const,
      accountId: account.accountId,
    };
    const result = await readBirthPageV1(
      mock.client,
      mock.reader,
      scope,
      undefined,
      new AbortController().signal,
      undefined,
      { account, scopeVersion: 99 },
    );
    expect(result.rows[0]?.account).toBe(account);
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years']);
  });
  it('fetches the account again when the supplied record has an older version', async () => {
    const mock = birthMockV1();
    const account = { ...mock.accounts[0]!, version: 1 };
    const scope = {
      kind: 'account' as const,
      academicYear: 2026 as const,
      accountId: account.accountId,
    };
    const result = await readBirthPageV1(
      mock.client,
      mock.reader,
      scope,
      undefined,
      new AbortController().signal,
      undefined,
      { account, scopeVersion: 99 },
    );
    expect(result.rows[0]?.account.version).toBe(mock.accounts[0]!.version);
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years', 'accounts-read']);
  });
  it('fetches fresh academic metadata when the scope revision changes without an account CAS change', async () => {
    const mock = birthMockV1();
    const account = mock.accounts[0]!;
    const scope = {
      kind: 'account' as const,
      academicYear: 2026 as const,
      accountId: account.accountId,
    };
    await readBirthPageV1(
      mock.client,
      mock.reader,
      scope,
      undefined,
      new AbortController().signal,
      undefined,
      { account, scopeVersion: 98 },
    );
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years', 'accounts-read']);
  });
  it('accepts only four ASCII digits in1900..2026, never trim/coerce incomplete input', () => {
    for (const value of ['1900', '2000', '2026']) expect(validBirthYearV1(value)).toBe(true);
    for (const value of [
      '',
      '2',
      '20',
      '201',
      '0000',
      '1899',
      '2027',
      ' 2000',
      '2000 ',
      '２０２０',
      '2e03',
      '20.0',
    ])
      expect(validBirthYearV1(value)).toBe(false);
  });
  it('pairs two opaque cursors across105 accounts and preserves all three distinct versions', async () => {
    const mock = birthMockV1({ count: 105 }),
      signal = new AbortController().signal;
    const first = await readBirthPageV1(
      mock.client,
      mock.reader,
      BIRTH_CLASS_V1,
      undefined,
      signal,
    );
    expect(first.rows).toHaveLength(100);
    expect(first.scopeVersion).toBe(47);
    expect(first.next?.accounts).not.toBe(first.next?.birth);
    const second = await readBirthPageV1(
      mock.client,
      mock.reader,
      BIRTH_CLASS_V1,
      first.next!,
      signal,
    );
    expect(second.rows).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(first.rows[0]?.account.version).toBe(19);
    expect(first.rows[0]?.birth.version).toBe(7);
    expect(first.rows[0]?.birth.confirmation).toBe('unconfirmed-test');
    expect(mock.queries).toHaveLength(4);
  });
  it('joins by identity even when a birth page arrives in another order', async () => {
    const mock = birthMockV1({
      query(query) {
        if (query.operation !== 'birth-years') return;
        return mock
          .defaultQuery(query)
          .json()
          .then((raw) => {
            const data = adminResponseV1.parse(raw);
            if (data.state !== 'birth-years') throw new Error('synthetic-unexpected-response');
            return birthJsonV1({ ...data, items: data.items.reverse() });
          });
      },
    });
    const page = await readBirthPageV1(
      mock.client,
      mock.reader,
      BIRTH_CLASS_V1,
      undefined,
      new AbortController().signal,
    );
    expect(page.rows[0]?.birth.year).toBe('2000');
    expect(page.rows[1]?.birth.year).toBeNull();
  });
  it('rejects mismatched account CAS rather than rebasing a birth draft', async () => {
    const mock = birthMockV1({
      query(query) {
        if (query.operation !== 'birth-years') return;
        return mock
          .defaultQuery(query)
          .json()
          .then((raw) => {
            const data = adminResponseV1.parse(raw);
            if (data.state !== 'birth-years') throw new Error('synthetic-unexpected-response');
            data.items[0]!.accountVersion++;
            return birthJsonV1(data);
          });
      },
    });
    await expect(
      readBirthPageV1(
        mock.client,
        mock.reader,
        BIRTH_CLASS_V1,
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ state: 'conflict' });
  });
  it('rejects closed, moved or mismatched identities and refuses school scope before a request', async () => {
    const mock = birthMockV1(),
      signal = new AbortController().signal;
    await expect(
      readBirthPageV1(
        mock.client,
        mock.reader,
        { kind: 'account', academicYear: 2026, accountId: mock.accounts[0]!.accountId },
        undefined,
        signal,
        754002,
      ),
    ).rejects.toMatchObject({ state: 'conflict' });
    mock.accounts[0]!.linkClosed = true;
    await expect(
      readBirthPageV1(mock.client, mock.reader, BIRTH_CLASS_V1, undefined, signal),
    ).rejects.toMatchObject({ state: 'conflict' });
    const before = mock.queries.length;
    await expect(
      readBirthPageV1(
        mock.client,
        mock.reader,
        // @ts-expect-error unsupported runtime input from a composition bug must also fail closed
        { kind: 'school', academicYear: 2026 },
        undefined,
        signal,
      ),
    ).rejects.toMatchObject({ state: 'invalid-request' });
    expect(mock.queries).toHaveLength(before);
  });
});
