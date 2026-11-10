import { describe, expect, it } from 'vitest';
import { adminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { readAccountBirthV1 } from '../../../../src/features/student-portal-admin/birth-year/birth-read-v1';
import { birthYearV1 } from '../../../../shared/student-portal-contracts/admin-v1';
const validBirthYearV1 = (value: string) => birthYearV1.safeParse(value).success;
import { birthMockV1, birthJsonV1 } from './fixtures-v1';

// The record reads one student's year (10/11/2026); class pages left with the Nascimento tab.
describe("one student's birth year for the record", () => {
  const signal = () => new AbortController().signal;
  it('reuses the record account only after the authorized birth read confirms its version', async () => {
    const mock = birthMockV1();
    const value = await readAccountBirthV1(mock.client, mock.reader, mock.accounts[0]!, 99, signal());
    expect(value).toMatchObject({ accountId: mock.accounts[0]!.accountId, year: '2000' });
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years']);
  });
  it('fetches the account again when the supplied record has an older version', async () => {
    const mock = birthMockV1();
    const account = { ...mock.accounts[0]!, version: 1 };
    const value = await readAccountBirthV1(mock.client, mock.reader, account, 99, signal());
    expect(value?.accountVersion).toBe(mock.accounts[0]!.version);
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years', 'accounts-read']);
  });
  it('fetches fresh academic metadata when the scope revision changes without an account CAS change', async () => {
    const mock = birthMockV1();
    await readAccountBirthV1(mock.client, mock.reader, mock.accounts[0]!, 98, signal());
    expect(mock.queries.map((query) => query.operation)).toEqual(['birth-years', 'accounts-read']);
  });
  it('accepts only four ASCII digits in1900..2026, never trim/coerce incomplete input', () => {
    for (const value of ['1900', '2000', '2026']) expect(validBirthYearV1(value)).toBe(true);
    for (const value of ['', '2', '20', '201', '0000', '1899', '2027', ' 2000', '2000 ', '２０２０', '2e03', '20.0'])
      expect(validBirthYearV1(value)).toBe(false);
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
      readAccountBirthV1(mock.client, mock.reader, mock.accounts[0]!, 99, signal()),
    ).rejects.toMatchObject({ state: 'conflict' });
  });
  it('treats a closed identity as not applicable, and writes nothing', async () => {
    const mock = birthMockV1();
    const account = { ...mock.accounts[0]!, linkClosed: true };
    mock.accounts[0]!.linkClosed = true;
    await expect(
      readAccountBirthV1(mock.client, mock.reader, account, 99, signal()),
    ).rejects.toMatchObject({ state: 'conflict' });
    expect(mock.writes).toHaveLength(0);
  });
});
