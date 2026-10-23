// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { servePortalScheduleV1 } from '../../../../server/student-portal/composition/schedule-v1';
import type { PortalCompositionEnvV1 } from '../../../../server/student-portal/composition/config-v1';
import { officialBells2026V1 } from '../../../../shared/student-portal-contracts/school-bells-v1';
import { officialCalendar2026V1 } from '../../../../shared/student-portal-contracts/school-calendar-2026-start-v1';

const mocks = vi.hoisted(() => ({
  unsafe:
    vi.fn<(query: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>>(),
  showSchedule: true,
}));
const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
vi.mock('../../../../server/student-portal/composition/config-v1', () => ({
  portalKeysV1: () => ({ cryptoPort: {} }),
}));
vi.mock('../../../../server/student-portal/composition/database-v1', () => ({
  portalDatabaseV1: async (
    _env: unknown,
    _operation: unknown,
    run: (sql: unknown) => Promise<unknown>,
  ) => run({}),
}));
vi.mock('../../../../server/student-portal/http/auth/handler-v1', () => ({
  sessionCookieTokenV1: () => 'a'.repeat(43),
}));
vi.mock(
  '../../../../server/student-portal/observability/operation-burst-v1',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../server/student-portal/observability/operation-burst-v1')
      >();
    return { ...actual, checkPortalOperationV1: async () => {} };
  },
);
vi.mock('../../../../server/student-portal/auth/session-service-v1', () => ({
  SessionServiceV1: class {
    async withAuthorized<T>(
      _token: string,
      operation: (
        context: { account: { id: string }; policy: { enforcedValue: { showSchedule: boolean } } },
        tx: { unsafe: typeof mocks.unsafe },
        session: { id: string; expiresAt: string; persistent: boolean },
      ) => Promise<T>,
    ) {
      return operation(
        { account: { id: accountId }, policy: { enforcedValue: { showSchedule: mocks.showSchedule } } },
        { unsafe: mocks.unsafe },
        { id: sessionId, expiresAt: '2026-10-22T13:00:00.000Z', persistent: false },
      );
    }
  },
}));
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: 'https://aluno.escolaieda.com',
  PORTAL_ADMIN_TENANT_ID: accountId,
  PORTAL_SERVING_ENABLED: 'true',
} satisfies PortalCompositionEnvV1;
const request = (query = '') => new Request(env.PORTAL_ORIGIN + '/api/student/schedule' + query);
const grid = {
  classes: [
    {
      label: 'TURMA SINTÉTICA A',
      observedAt: '2026-10-22 11:00:00+00',
      lessons: [{ weekday: 1, slot: 1, subject: 'LINGUA PORTUGUESA' }],
    },
  ],
};
beforeEach(() => {
  mocks.unsafe.mockReset();
  mocks.showSchedule = true;
});

it('refuses the read without touching the grid when the Horário policy is off', async () => {
  mocks.showSchedule = false;
  const response = await servePortalScheduleV1(request(), env);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ contractVersion: 1, state: 'forbidden' });
  expect(mocks.unsafe).not.toHaveBeenCalled();
});

const clock = { active: true, today: '2026-10-22', now: '2026-10-22T12:30:00.000Z' };
it("returns the student's own grid, read with its account and session only", async () => {
  mocks.unsafe
    .mockResolvedValueOnce([{ schedule: grid }])
    .mockResolvedValueOnce([clock])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  const response = await servePortalScheduleV1(request(), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  // No bells nor calendar marked yet: the grid without times, no day without school.
  expect(await response.json()).toEqual({
    contractVersion: 1,
    state: 'ready',
    classes: grid.classes.map((item) => ({ ...item, bells: null })),
    today: '2026-10-22',
    now: '2026-10-22T12:30:00.000Z',
    daysOff: [],
  });
  expect(mocks.unsafe.mock.calls[0]?.[1]).toEqual([accountId, sessionId]);
});

it("adds the bells of each class's shift and the days without school (owner decision 23/10/2026)", async () => {
  const classes = [
    { label: '6º ANO A - MATUTINO', observedAt: 'x', lessons: [] },
    { label: 'AEE', observedAt: 'x', lessons: [] },
  ];
  mocks.unsafe
    .mockResolvedValueOnce([{ schedule: { classes } }])
    .mockResolvedValueOnce([clock])
    .mockResolvedValueOnce([{ bells_json: officialBells2026V1() }])
    .mockResolvedValueOnce([{ days_json: officialCalendar2026V1() }]);
  const body = (await (await servePortalScheduleV1(request(), env)).json()) as {
    classes: { bells: unknown }[];
    daysOff: { date: string; kind: string; note?: string }[];
  };
  expect(body.classes.map((item: { bells: unknown }) => item.bells)).toEqual([officialBells2026V1().matutino, null]);
  expect(body.daysOff).toContainEqual({ date: '2026-10-12', kind: 'feriado', note: 'Nossa Senhora Aparecida' });
  expect(body.daysOff.every((day: { kind: string }) => ['feriado', 'recesso', 'evento'].includes(day.kind))).toBe(true);
});

it('suppresses a result read past the session expiry', async () => {
  mocks.unsafe
    .mockResolvedValueOnce([{ schedule: grid }])
    .mockResolvedValueOnce([{ active: false }]);
  const response = await servePortalScheduleV1(request(), env);
  expect(response.status).toBe(401);
});

it('reads a session the database no longer accepts as unauthenticated', async () => {
  mocks.unsafe.mockResolvedValueOnce([{ schedule: null }]);
  expect((await servePortalScheduleV1(request(), env)).status).toBe(401);
});

it('rejects a query string and anything outside the recognized grid', async () => {
  // The request guard refuses any query on this path (no class or student can be asked for).
  expect((await servePortalScheduleV1(request('?classId=1'), env)).status).toBe(403);
  expect(mocks.unsafe).not.toHaveBeenCalled();
  for (const lessons of [
    [{ weekday: 6, slot: 1, subject: 'X' }],
    [{ weekday: 1, slot: 7, subject: 'X' }],
    [{ weekday: 1, slot: 1, subject: '' }],
    [{ weekday: 1, slot: 1, subject: 'X', teacher: 'Y' }],
  ]) {
    mocks.unsafe.mockReset();
    mocks.unsafe.mockResolvedValueOnce([
      { schedule: { classes: [{ label: 'A', observedAt: 'x', lessons }] } },
    ]);
    expect((await servePortalScheduleV1(request(), env)).status).toBe(503);
  }
});
