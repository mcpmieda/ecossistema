// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seal } from '../server/auth/sealed';
import {
  createApplicationSession,
  readSession,
  SESSION_COOKIE,
  sessionDurationOptionsFor,
  WRITE_SESSION_MAX_HOURS,
} from '../server/auth/session';
import { classifyAdminOperationV1 } from '../server/http/admin-rate-limit-v1';
import {
  RECONCILIATION_READ_OPERATIONS_V1,
  RECONCILIATION_ROUTE_V1,
} from '../shared/student-identity/reconciliation-v1';
import { testEnv } from './fixtures';

const oid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hour = 60 * 60;

afterEach(() => vi.useRealTimers());

describe('A25: an ADM session with write power cannot outlive the cap', () => {
  it('caps a new administrator session at 8 h, and leaves other roles with their choice', () => {
    const at = 1_800_000_000;
    const admin = createApplicationSession({ oid, name: 'Pessoa', roles: ['ADMINISTRADOR'] }, 12, at);
    expect(WRITE_SESSION_MAX_HOURS).toBe(8);
    expect(admin.exp).toBe(at + 8 * hour);
    expect(admin.durationHours).toBe(8);
    const teacher = createApplicationSession({ oid, name: 'Pessoa', roles: ['PROFESSOR'] }, 12, at);
    expect(teacher.exp).toBe(at + 12 * hour);
  });

  it('offers only lengths within the cap to a session with write power', () => {
    expect(sessionDurationOptionsFor(['ADMINISTRADOR'])).toEqual([4, 8]);
    expect(sessionDurationOptionsFor(['PROFESSOR'])).toEqual([4, 8, 12]);
  });

  it('ends a 12 h administrator cookie sealed before the cap at 8 h', async () => {
    const at = 1_800_000_000;
    const token = await seal(
      { oid, name: 'Pessoa', roles: ['ADMINISTRADOR'], authenticatedAt: at, durationHours: 12, exp: at + 12 * hour },
      testEnv.SESSION_SECRET,
    );
    const request = () => new Request('https://x.test', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    vi.useFakeTimers();
    vi.setSystemTime((at + 7 * hour) * 1000);
    const early = await readSession(request(), testEnv);
    expect(early?.exp).toBe(at + 8 * hour);
    vi.setSystemTime((at + 9 * hour) * 1000);
    await expect(readSession(request(), testEnv)).resolves.toBeNull();
  });
});

describe('A26: Conciliação reads spend the read budget', () => {
  it.each(['pending-count', 'automatic-report', 'catalog', 'list', 'detail'])('%s is a read', (operation) => {
    expect(classifyAdminOperationV1(RECONCILIATION_ROUTE_V1, 'POST', { operation })).toBe('read');
    expect(RECONCILIATION_READ_OPERATIONS_V1).toContain(operation);
  });

  it('keeps every other operation a write', () => {
    expect(classifyAdminOperationV1(RECONCILIATION_ROUTE_V1, 'POST', { operation: 'import' })).toBe('write');
  });
});
