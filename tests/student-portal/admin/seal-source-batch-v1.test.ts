// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readSealsV1 } from '../../../server/student-portal/admin/seals-read-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { publicationContextV1 } from '../../../server/student-portal/publication/self-projection-reader-v1';
import { scopedSelfV2 } from '../../../server/student-portal/publication/scoped-self-v2';
import { brilliantSealCountV1 } from '../../../shared/student-portal-contracts/brilliant-seal-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { PERIODS_V1 } from '../../../server/student-portal/publication/state-v1';
import {
  parallelFixture848,
  PARALLEL_VERSION_848,
} from '../../gradebook/performance/parallel-visibility-fixture-848';

const now = new Date('2026-09-18T00:00:00.000Z');
const requestId = '75600000-0000-4000-8000-000000000001';
const scope = { kind: 'class' as const, academicYear: 2026 as const, classId: 848001 };
const query = {
  contractVersion: 2 as const,
  operation: 'seals-read' as const,
  page: { limit: 100 },
  scope,
};
const id = (index: number) => `75600000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;

function fixture(index: number, options: { closings?: boolean; visible?: boolean } = {}) {
  const academic = parallelFixture848({
    studentId: 848001 + index,
    term: 2,
    av1: 6750,
    av2: 6750,
    qualitative: 16500,
  });
  const defaults = initialPolicyDefaultsV1();
  const value = {
    ...defaults,
    accessEnabled: options.visible !== false,
    showPartials: true,
    showFinalResult: true,
    showTermClosing: options.closings === true,
    allowedPeriods: [...PERIODS_V1],
    calendar: {
      ...defaults.calendar,
      yearStartsAt: '2026-01-01T00:00:00Z',
      t1EndsAt: '2026-04-01T00:00:00Z',
      t2StartsAt: '2026-04-02T00:00:00Z',
      t2EndsAt: '2026-07-01T00:00:00Z',
      t3StartsAt: '2026-07-02T00:00:00Z',
      t3EndsAt: '2026-08-31T00:00:00Z',
      recoveriesStartAt: '2026-09-01T00:00:00Z',
      yearEndsAt: '2026-12-31T23:59:59Z',
      finalDisclosureAt: '2026-09-17T00:00:00Z',
      disclosure: { mode: 'single', at: null, periods: [...PERIODS_V1] },
    },
  };
  const row = {
    id: id(index),
    academic_year: 2026,
    gradebook_student_id: academic.link.studentId,
    auth_state: 'active',
    eligibility: 'eligible',
    blocked: false,
    version: 1,
    account_version: '1',
    security_version: 1,
    pin_version: 1,
    closed_at: null as string | null,
    resolved: true,
    class_id: scope.classId,
    shift: null,
    data_version: PARALLEL_VERSION_848,
    bindings: academic.portalSource.bindings.map((binding) => ({
      academicYear: binding.academicYear,
      studentId: binding.studentId,
      classId: binding.classId,
      status: binding.status,
    })),
    settings_rows: Object.entries(value).map(([field_key, value_json]) => ({
      scope_key: 'school:2026',
      field_key,
      value_json,
      source_scope_json: { kind: 'school', academicYear: 2026 },
      version: 1,
    })) as Record<string, unknown>[],
    profiles: [
      {
        name: 'ESTUDANTE SINTETICO',
        class_name: 'TURMA SINTETICA',
        status: null,
        observed_class: scope.classId,
        assessment_names: {},
        assessments: [],
      },
    ],
  };
  const payload = academic.portalSource;
  const sources = PERIODS_V1.map((period, position) => ({
    account_id: row.id,
    period,
    mask: 1 << position,
    decision_version: 1,
    approved_revision: PARALLEL_VERSION_848,
    target_revision: PARALLEL_VERSION_848,
    payload_json: payload,
    edition_class_id: scope.classId,
    edition_revision: '1',
    available_mask: 63,
    latest_revision: '1',
  }));
  const closing = {
    account_id: row.id,
    student_id: academic.link.studentId,
    uid: `synthetic:${index}`,
    payload_json: payload,
    class_id: scope.classId,
    revision: PARALLEL_VERSION_848,
  };
  return { row, sources, closing };
}
type Fixture = ReturnType<typeof fixture>;

function database(fixtures: Fixture[]) {
  const calls: string[] = [];
  const tx: StudentPortalPostgresQueryV1 = {
    async unsafe<R extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      calls.push(sql);
      let rows: Record<string, unknown>[];
      const selected = fixtures.find(
        (item) => item.row.id === values[0] || item.row.id === values[1],
      );
      if (sql.includes('SELECT statement_timestamp()')) rows = [{ now }];
      else if (sql.includes(' AS profiles')) {
        // Production disables dynamic array type discovery; IDs must cross as JSON text.
        expect(sql).toContain('jsonb_array_elements_text($1::text::jsonb)');
        expect(values).toEqual([JSON.stringify(fixtures.map((item) => item.row.id))]);
        rows = fixtures.map((item) => item.row);
      } else if (sql.includes('SELECT a.id ') && sql.includes('LIMIT 201'))
        rows = fixtures.map(({ row }) => ({ id: row.id }));
      else if (sql.includes('selected.*'))
        rows = sql.includes('jsonb_to_recordset')
          ? fixtures.flatMap((item) => item.sources)
          : (selected?.sources ?? []);
      else if (sql.includes(' AS uid') && sql.includes('jsonb_to_recordset'))
        rows = fixtures.map((item) => item.closing);
      else if (sql.includes('SELECT to_jsonb(a)'))
        rows = selected ? [{ uid: selected.closing.uid }] : [];
      else if (sql.includes('SELECT s.payload_json'))
        rows = fixtures
          .filter((item) => item.row.gradebook_student_id === values[0])
          .map((item) => item.closing);
      else if (sql.includes('SELECT s.name')) rows = selected?.row.profiles ?? [];
      else if (sql.includes('WITH current_account')) rows = selected ? [selected.row] : [];
      else if (sql.includes(' AS bindings'))
        rows = fixtures
          .filter((item) => item.row.gradebook_student_id === values[1])
          .map(({ row }) => row);
      else if (sql.includes('FROM student_portal.account WHERE id='))
        rows = selected ? [selected.row] : [];
      else throw new Error('unexpected-test-query');
      return rows as R[];
    },
  };
  return { tx, calls };
}

async function canonical(item: Fixture, queryCounts?: number[]) {
  const { tx, calls } = database([item]);
  const sql = {
    unsafe: tx.unsafe.bind(tx),
    begin: <T>(run: (value: StudentPortalPostgresQueryV1) => Promise<T>) => run(tx),
  };
  const context = await new StudentPortalPostgresPersistenceV1(sql).transaction((store) =>
    publicationContextV1(sql, tx, store, item.row.id, false, false),
  );
  if (!context) {
    queryCounts?.push(calls.length);
    return null;
  }
  const self = await scopedSelfV2(tx, context, requestId);
  queryCounts?.push(calls.length);
  return self.state === 'ready' ? brilliantSealCountV1(self.subjects, self.endedPeriods) : null;
}

describe('bounded seal source batches', () => {
  it.each([2, 200])(
    'uses four SQL statements for %i students without term closings',
    async (size) => {
      const fixtures = Array.from({ length: size }, (_, index) => fixture(index));
      const { tx, calls } = database(fixtures);
      const result = await readSealsV1(tx, query, requestId, now);
      expect(result.state).toBe('seals-read');
      expect('items' in result && result.items).toHaveLength(size);
      expect(calls).toHaveLength(4);
      const baseline: number[] = [];
      await canonical(fixtures[0]!, baseline);
      expect(baseline).toEqual([6]);
      expect(calls.length).toBeLessThan(1 + baseline[0]! * size);
      expect(calls.every((sql) => !/FOR UPDATE|INSERT|UPDATE student_portal/.test(sql))).toBe(true);
    },
  );

  it.each([false, true])(
    'matches the one-student canonical projection with term closing=%s',
    async (closings) => {
      const fixtures = [
        fixture(0, { closings }),
        fixture(1, { closings, visible: false }),
        fixture(2, { closings }),
      ];
      fixtures[2]!.row.blocked = true;
      const expected = await Promise.all(fixtures.map((item) => canonical(item)));
      const { tx, calls } = database(fixtures);
      const result = await readSealsV1(tx, query, requestId, now);
      expect(result).toMatchObject({
        state: 'seals-read',
        items: fixtures.map(({ row }, index) => ({ accountId: row.id, seals: expected[index] })),
      });
      expect(expected[0]).toBeTypeOf('number');
      expect(expected[1]).toBeNull();
      expect(expected[2]).toBeNull();
      expect(calls).toHaveLength(closings ? 5 : 4);
    },
  );

  it('keeps ambiguous, closed, and class-mismatched contexts unavailable', async () => {
    const fixtures = Array.from({ length: 4 }, (_, index) => fixture(index));
    fixtures[0]!.row.closed_at = now.toISOString();
    fixtures[1]!.row.bindings.push({
      ...fixtures[1]!.row.bindings[0]!,
      classId: scope.classId + 1,
    });
    fixtures[2]!.row.profiles[0]!.observed_class = scope.classId + 1;
    fixtures[3]!.sources.forEach((row) => {
      row.edition_class_id = scope.classId + 1;
    });
    const expected = await Promise.all(fixtures.map((item) => canonical(item)));
    const { tx } = database(fixtures);
    expect(await readSealsV1(tx, query, requestId, now)).toMatchObject({
      items: fixtures.map(({ row }, index) => ({ accountId: row.id, seals: expected[index] })),
    });
    expect(expected).toEqual([null, null, null, null]);
  });

  it('preserves account overrides, private partials, and future calendar disclosure', async () => {
    const fixtures = Array.from({ length: 4 }, (_, index) => fixture(index));
    const override = (index: number, field_key: string, value_json: unknown) => {
      const row = fixtures[index]!.row;
      row.settings_rows.push({
        scope_key: `account:2026:${row.id}`,
        field_key,
        value_json,
        source_scope_json: { kind: 'account', academicYear: 2026, accountId: row.id },
        version: 1,
      });
    };
    override(1, 'showPartials', false);
    override(2, 'allowedPeriods', ['T1']);
    const calendar = fixtures[3]!.row.settings_rows.find(
      (row) => row.field_key === 'calendar',
    )!.value_json;
    override(3, 'calendar', {
      ...(calendar as object),
      disclosure: { mode: 'single', at: '2026-12-01T00:00:00Z', periods: [...PERIODS_V1] },
    });
    const expected = await Promise.all(fixtures.map((item) => canonical(item)));
    const { tx, calls } = database(fixtures);
    expect(await readSealsV1(tx, query, requestId, now)).toMatchObject({
      items: fixtures.map(({ row }, index) => ({ accountId: row.id, seals: expected[index] })),
    });
    expect(expected[0]).toBeGreaterThan(0);
    expect(expected[1]).toBeLessThan(expected[0]!);
    expect(expected[2]).toBeLessThan(expected[0]!);
    expect(expected[3]).toBeNull();
    expect(calls).toHaveLength(4);
  });
});
