// @vitest-environment node
import { expect, it } from 'vitest';
import { readBirthCollectionV1 } from '../../../../src/features/student-portal-admin/birth-year/birth-read-v1';
import { birthMockV1, birthIdV1 } from './fixtures-v1';

it('consulta nascimento em páginas pareadas, sem abrir outro gravador manual', async () => {
  const mock = birthMockV1({ count: 1005 });
  const signal = new AbortController().signal;
  let page = await readBirthCollectionV1(mock.client, mock.reader, mock.props.scope, signal);
  expect(page.rows).toHaveLength(100);
  expect(mock.queries).toHaveLength(2);
  for (let number = 2; number <= 11; number++) {
    page = await readBirthCollectionV1(
      mock.client,
      mock.reader,
      mock.props.scope,
      signal,
      100,
      page,
    );
    expect(page.rows).toHaveLength(Math.min(number * 100, 1005));
  }
  expect(page.next).toBeNull();
  expect(page.rows.map((row) => row.account.accountId)).toEqual(
    Array.from({ length: 1005 }, (_, index) => birthIdV1(index + 1)),
  );
  expect(mock.queries.every((query) => query.page.limit === 100)).toBe(true);
  expect(mock.writes).toHaveLength(0);
});
