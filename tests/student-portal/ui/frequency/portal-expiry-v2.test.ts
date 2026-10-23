// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { servePortalFrequencyV2 } from '../../../../server/student-portal/composition/frequency-v2';
import type { PortalCompositionEnvV1 } from '../../../../server/student-portal/composition/config-v1';

const mocks = vi.hoisted(() => ({
  unsafe:
    vi.fn<(query: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>>(),
  effectiveExpiry: '2026-10-14T13:00:00.000Z',
  showFrequency: true,
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
        context: { account: { id: string }; policy: { enforcedValue: { showFrequency: boolean } } },
        tx: { unsafe: typeof mocks.unsafe },
        session: { id: string; expiresAt: string; persistent: boolean },
      ) => Promise<T>,
    ) {
      return operation(
        { account: { id: accountId }, policy: { enforcedValue: { showFrequency: mocks.showFrequency } } },
        { unsafe: mocks.unsafe },
        { id: sessionId, expiresAt: mocks.effectiveExpiry, persistent: false },
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
// The school's today in every read (attendance 0012); after the synthetic days of October.
const TODAY = '2026-10-22';
const request = () => new Request(env.PORTAL_ORIGIN + '/api/student/frequency?month=2026-10');
beforeEach(() => {
  mocks.unsafe.mockReset();
  mocks.showFrequency = true;
});

it('refuses the read without touching attendance data when the Frequência policy is off', async () => {
  mocks.showFrequency = false;
  const response = await servePortalFrequencyV2(request(), env);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ contractVersion: 2, state: 'forbidden' });
  expect(mocks.unsafe).not.toHaveBeenCalled();
});

it('checks the effective policy/session expiration with database time after reading origins and suppresses an expired result', async () => {
  mocks.unsafe
    .mockResolvedValueOnce([
      {
        frequency: { today: TODAY, lastReadAt: null, days: [], origins: [
          {
            occurrence_id: '33333333-3333-4333-8333-333333333333',
            date: '2026-10-01',
            slot: 1,
            shift: 'matutino',
            mark: 'X',
            conflict_id: null,
            source_class_label: 'PRIVATE_SYNTHETIC_CLASS',
            observed_at: '2026-10-14T12:00:00Z',
            received_at: '2026-10-14T12:01:00Z',
            mapping_valid: true,
          },
        ] },
      },
    ])
    .mockResolvedValueOnce([{ active: false }]);
  const result = await servePortalFrequencyV2(request(), env);
  // One read of the whole year; the month is worked out from it.
  expect(mocks.unsafe.mock.calls[0]?.[1]).toEqual([accountId, sessionId, '2026-01', '2026-12']);
  expect(mocks.unsafe.mock.calls[1]?.[0]).toContain('clock_timestamp()');
  expect(mocks.unsafe.mock.calls[1]?.[1]).toEqual([mocks.effectiveExpiry]);
  expect(result.status).toBe(401);
  expect(await result.text()).not.toContain('PRIVATE_SYNTHETIC_CLASS');
  expect(result.headers.get('Cache-Control')).toContain('no-store');
});

it('returns a private incomplete summary only while the effective session remains live', async () => {
  mocks.unsafe.mockResolvedValueOnce([{ frequency: { today: TODAY, lastReadAt: null, origins: [], days: [] } }]).mockResolvedValueOnce([{ active: true }]);
  const result = await servePortalFrequencyV2(request(), env);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    contractVersion: 2,
    state: 'ready',
    coverage: 'unavailable',
    denominator: null,
    percentage: null,
    marks: [],
  });
});

it('counts lessons, absences and justified absences from complete Smecel lesson days', async () => {
  const mark = (slot: number, value: 'X' | 'J', id: string) => ({
    occurrence_id: id, date: '2026-10-06', slot, shift: 'matutino', mark: value, conflict_id: null,
    source_class_label: 'PRIVATE_SYNTHETIC_CLASS', observed_at: '2026-10-14T12:00:00Z',
    received_at: '2026-10-14T12:01:00Z', mapping_valid: true,
  });
  const day = (date: string, slots: number[], complete = true) => ({ date, shift: 'matutino', slots_json: slots, complete });
  mocks.unsafe
    .mockResolvedValueOnce([{ frequency: { today: TODAY, lastReadAt: null,
      origins: [mark(2, 'X', '33333333-3333-4333-8333-333333333331'), mark(4, 'J', '33333333-3333-4333-8333-333333333332')],
      // A 5-lesson Monday and a 6-lesson Tuesday: no configuration, straight from the diary.
      days: [day('2026-10-05', [1, 2, 3, 4, 5]), day('2026-10-06', [1, 2, 3, 4, 5, 6])],
    } }])
    .mockResolvedValueOnce([{ active: true }]);
  const result = await servePortalFrequencyV2(request(), env);
  expect(await result.json()).toMatchObject({
    coverage: 'reliable', denominator: 11, absences: 1, justified: 1, percentage: 90.9,
    days: [{ date: '2026-10-05', slots: [1, 2, 3, 4, 5], complete: true }, { date: '2026-10-06', slots: [1, 2, 3, 4, 5, 6], complete: true }],
  });
  // One day read partially: the totals are withheld instead of being wrong; marks and days stay.
  mocks.unsafe
    .mockResolvedValueOnce([{ frequency: { today: TODAY, lastReadAt: null, origins: [mark(2, 'X', '33333333-3333-4333-8333-333333333331')],
      days: [day('2026-10-05', [1, 2, 3, 4, 5]), day('2026-10-06', [2], false)] } }])
    .mockResolvedValueOnce([{ active: true }]);
  expect(await (await servePortalFrequencyV2(request(), env)).json()).toMatchObject({
    coverage: 'incomplete', denominator: null, percentage: null, absences: null, justified: null,
  });
  // A tombstone (a record with no lesson that day any more) is accepted and never spoils the day.
  mocks.unsafe
    .mockResolvedValueOnce([{ frequency: { today: TODAY, lastReadAt: null, origins: [mark(2, 'X', '33333333-3333-4333-8333-333333333331')],
      days: [day('2026-10-05', [1, 2, 3, 4, 5]), day('2026-10-06', [1, 2, 3, 4, 5, 6]), day('2026-10-06', []), day('2026-10-07', [])] } }])
    .mockResolvedValueOnce([{ active: true }]);
  const tombstoned = (await (await servePortalFrequencyV2(request(), env)).json()) as { days: { date: string }[] };
  expect(tombstoned).toMatchObject({ coverage: 'reliable', denominator: 11, absences: 1, percentage: 90.9 });
  expect(tombstoned.days.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06']);
});

it('rejects a caller-provided student UID before reading any private origins', async () => {
  const result = await servePortalFrequencyV2(
    new Request(env.PORTAL_ORIGIN + '/api/student/frequency?month=2026-10&studentUid=' + accountId),
    env,
  );
  expect(result.status).toBe(403);
  expect(mocks.unsafe).not.toHaveBeenCalled();
});

it("never counts today, adds the year up to now and gives the class's last reading", async () => {
  const mark = (date: string, slot: number, value: 'X' | 'J', id: string) => ({
    occurrence_id: id, date, slot, shift: 'matutino', mark: value, conflict_id: null,
    source_class_label: 'PRIVATE_SYNTHETIC_CLASS', observed_at: '2026-10-14T12:00:00Z',
    received_at: '2026-10-14T12:01:00Z', mapping_valid: true,
  });
  const day = (date: string, slots: number[], complete = true) => ({ date, shift: 'matutino', slots_json: slots, complete });
  const read = (days: ReturnType<typeof day>[], origins: ReturnType<typeof mark>[] = []) => [{ frequency: {
    today: '2026-10-07', lastReadAt: '2026-10-07 09:30:00+00', origins, days,
  } }];
  mocks.unsafe
    .mockResolvedValueOnce(read(
      [day('2026-09-30', [1, 2, 3, 4, 5]), day('2026-10-06', [1, 2, 3, 4, 5]), day('2026-10-07', [1, 2], false)],
      [mark('2026-09-30', 1, 'X', '33333333-3333-4333-8333-333333333331'),
        mark('2026-10-07', 1, 'X', '33333333-3333-4333-8333-333333333332'),
        mark('2026-10-07', 2, 'J', '33333333-3333-4333-8333-333333333333')],
    ))
    .mockResolvedValueOnce([{ active: true }]);
  // Today (07/10) is half read and has an absence and a justified one: neither its lessons nor its
  // marks count, and the month stays reliable. The year: September's 5 lessons and 1 X plus
  // October's 5. Today's marks are still shown.
  expect(await (await servePortalFrequencyV2(request(), env)).json()).toMatchObject({
    today: '2026-10-07', coverage: 'reliable', denominator: 5, absences: 0, justified: 0, percentage: 100,
    year: { lessons: 10, absences: 1 }, lastReadAt: '2026-10-07T09:30:00.000Z',
    marks: [{ date: '2026-10-07', slot: 1, mark: 'X' }, { date: '2026-10-07', slot: 2, mark: 'J' }],
  });
  // A past month not read in full leaves the year unknown; the month asked for still has totals.
  mocks.unsafe
    .mockResolvedValueOnce(read([day('2026-09-30', [1, 2, 3], false), day('2026-10-06', [1, 2, 3, 4, 5])]))
    .mockResolvedValueOnce([{ active: true }]);
  expect(await (await servePortalFrequencyV2(request(), env)).json()).toMatchObject({
    coverage: 'reliable', denominator: 5, year: null,
  });
  // A month after today adds nothing to the year.
  mocks.unsafe
    .mockResolvedValueOnce(read([day('2026-10-06', [1, 2, 3, 4, 5]), day('2026-11-03', [1, 2], false)]))
    .mockResolvedValueOnce([{ active: true }]);
  expect(await (await servePortalFrequencyV2(request(), env)).json()).toMatchObject({
    year: { lessons: 5, absences: 0 },
  });
});

it('answers the whole year so far in one read (?year=2026), month by month, on the calendar days only', async () => {
  const day = (date: string, slots: number[]) => ({ date, shift: 'matutino', slots_json: slots, complete: true });
  mocks.unsafe
    .mockResolvedValueOnce([{ frequency: {
      today: '2026-03-10', lastReadAt: '2026-03-10 09:30:00+00', origins: [],
      // 28/02: a compensation Saturday the diary has but the official calendar does not.
      days: [day('2026-02-23', [1, 2, 3, 4, 5]), day('2026-02-28', [1, 2, 3, 4, 5]), day('2026-03-09', [1, 2, 3, 4, 5])],
    } }])
    .mockResolvedValueOnce([{ active: true }])
    // The school's calendar (ADM): four school days, two of them from today on.
    .mockResolvedValueOnce([{ days_json: [
      { date: '2026-02-23', kind: 'evento-letivo', note: 'Início do ano letivo' },
      { date: '2026-03-09', kind: 'letivo' }, { date: '2026-03-10', kind: 'letivo' },
      { date: '2026-03-11', kind: 'feriado', note: 'Feriado' }, { date: '2026-03-12', kind: 'letivo' },
    ] }]);
  const result = await servePortalFrequencyV2(new Request(env.PORTAL_ORIGIN + '/api/student/frequency?year=2026'), env);
  const body = (await result.json()) as { months: { month: string; denominator: number | null }[] };
  expect(body).toMatchObject({ contractVersion: 2, state: 'ready', academicYear: 2026, today: '2026-03-10', year: { lessons: 10, absences: 0 } });
  expect(body).toMatchObject({ schoolYear: { schoolDays: 4, remaining: 2, firstDay: '2026-02-23', lastDay: '2026-03-12' } });
  expect(body.months.map((month) => [month.month, month.denominator])).toEqual([['2026-01', null], ['2026-02', 5], ['2026-03', 5]]);
  // Only one of the two forms, and only this year.
  for (const query of ['?year=2025', '?year=2026&month=2026-03', '?year=all'])
    expect((await servePortalFrequencyV2(new Request(env.PORTAL_ORIGIN + '/api/student/frequency' + query), env)).status).toBeGreaterThanOrEqual(400);
});
