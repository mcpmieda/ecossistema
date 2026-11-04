// @vitest-environment node
import { expect, it } from 'vitest';
import {
  readBirthPageV1,
  type BirthCursorsV1,
} from '../../../../src/features/student-portal-admin/birth-year/birth-read-v1';
import { collectCursorPagesV1 } from '../../../../src/features/student-portal-admin/shared/continuous-read-v1';
import { birthMockV1, birthIdV1 } from './fixtures-v1';

it('consulta nascimento em páginas pareadas, sem abrir outro gravador manual', async () => {
  const mock = birthMockV1({ count: 1005 });
  const signal = new AbortController().signal;
  // Same page loader as the screen: both opaque cursors travel together as one cursor.
  const load = async (cursor: string | undefined, pageSignal: AbortSignal) => {
    const pair = cursor ? (JSON.parse(cursor) as BirthCursorsV1) : undefined;
    const result = await readBirthPageV1(mock.client, mock.reader, mock.props.scope, pair, pageSignal);
    return {
      items: result.rows.map((row) => ({ ...row, accountId: row.account.accountId })),
      nextCursor: result.next ? JSON.stringify(result.next) : null,
    };
  };
  let page = await collectCursorPagesV1(load, signal, 'accountId', null, 100);
  expect(page.items).toHaveLength(100);
  expect(mock.queries).toHaveLength(2);
  for (let number = 2; number <= 11; number++) {
    page = await collectCursorPagesV1(load, signal, 'accountId', page, 100);
    expect(page.items).toHaveLength(Math.min(number * 100, 1005));
  }
  expect(page.nextCursor).toBeNull();
  expect(page.items.map((row) => row.account.accountId)).toEqual(
    Array.from({ length: 1005 }, (_, index) => birthIdV1(index + 1)),
  );
  expect(mock.queries.every((query) => query.page.limit === 100)).toBe(true);
  expect(mock.writes).toHaveLength(0);
});
