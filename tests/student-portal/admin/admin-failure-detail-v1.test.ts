import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { adminFailureDetailV1 } from '../../../server/student-portal/admin/common-v1';

describe('adminFailureDetailV1', () => {
  test('a schema failure keeps only paths and codes, never the values', () => {
    const result = z.object({ name: z.string().max(3) }).safeParse({ name: 'PERICLES COSTA' });
    expect(result.success).toBe(false);
    const detail = adminFailureDetailV1(result.error);
    expect(detail).toEqual({ kind: 'schema', issues: ['name:too_big'] });
    expect(JSON.stringify(detail)).not.toContain('PERICLES');
  });
  test('a database error keeps its SQLSTATE, not its message', () => {
    const error = Object.assign(new Error('column "secret value" does not exist'), { code: '42703' });
    expect(adminFailureDetailV1(error)).toEqual({ kind: 'Error', code: '42703' });
  });
  test('a portal error keeps its fixed message', () => {
    expect(adminFailureDetailV1(new Error('student-portal-admin-unavailable'))).toEqual({
      kind: 'Error',
      message: 'student-portal-admin-unavailable',
    });
  });
});
