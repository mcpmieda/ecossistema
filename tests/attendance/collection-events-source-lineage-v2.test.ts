// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { collectionEvents } from '../../server/attendance/service-v2';

type Arguments = Parameters<typeof collectionEvents>;
const source = (record_key: string) =>
  ({
    record_key,
    student_uid: '00000000-0000-4000-8000-000000000001',
    eligibility_json: [],
  }) as unknown as Arguments[2][number];
const incoming = (recordKey: string, mark: 'X' | 'J') => ({
  recordKey,
  date: '2026-10-16',
  slot: 1,
  mark,
});
describe('frequency multi-origin baseline', () => {
  it('compares each source to its own earlier mark, not a sibling origin', async () => {
    const historical = [
      {
        record_key: 'a',
        student_uid: source('a').student_uid,
        date: '2026-10-16',
        slot: 1,
        mark: 'X',
      },
      {
        record_key: 'b',
        student_uid: source('b').student_uid,
        date: '2026-10-16',
        slot: 1,
        mark: 'J',
      },
    ];
    let sql = '';
    const tx = {
      query: async (query: string) => {
        sql = query;
        return historical;
      },
    } as unknown as Arguments[0];
    const input = {
      academicYear: 2026,
      classId: 1,
      requestId: '00000000-0000-4000-8000-000000000002',
      marks: [incoming('a', 'X'), incoming('b', 'J')],
      coverage: [],
    } as unknown as Arguments[1];
    const unchanged = await collectionEvents(tx, input, [source('b'), source('a')]);
    expect(unchanged).toHaveLength(2);
    expect(unchanged.every((e) => !e.changed)).toBe(true);
    expect(sql).toContain('DISTINCT ON(p.record_key,o.student_uid,o.date,o.slot)');
    expect(sql).toContain('p.record_key');
    input.marks = [incoming('a', 'J'), incoming('b', 'J')];
    const changed = await collectionEvents(tx, input, [source('a'), source('b')]);
    expect(changed.map((e) => ({ recordKey: e.recordKey, changed: e.changed }))).toEqual([
      { recordKey: 'a', changed: true },
      { recordKey: 'b', changed: false },
    ]);
  });
});
describe('marks of a day the diary no longer gives a record', () => {
  const uid = source('a').student_uid as string;
  const held = (record_key: string, date: string) => ({
    record_key,
    student_uid: uid,
    date,
    slot: 1,
    mark: 'X',
  });
  const run = async (
    historical: ReturnType<typeof held>[],
    input: object,
    sources: string[],
    otherClass: string[] = [],
  ) => {
    const queries: string[] = [];
    const tx = {
      query: async (query: string) => {
        queries.push(query);
        return queries.length === 1 ? historical : otherClass.map((value) => ({ uid: value }));
      },
    } as unknown as Arguments[0];
    const events = await collectionEvents(
      tx,
      {
        academicYear: 2026,
        classId: 1,
        requestId: '00000000-0000-4000-8000-000000000002',
        marks: [],
        coverage: [],
        ...input,
      } as unknown as Arguments[1],
      sources.map(source),
    );
    return { events, queries };
  };
  const removal = { date: '2026-10-23', slot: 1, mark: null, recordKey: 'a', changed: true };

  it('removes them when the record no longer has the day', async () => {
    const { events, queries } = await run(
      [held('a', '2026-10-22'), held('a', '2026-10-23')],
      {
        coverage: [{ recordKey: 'a', date: '2026-10-22', slots: [1, 2], complete: true }],
        marks: [{ recordKey: 'a', date: '2026-10-22', slot: 1, mark: 'X' }],
      },
      ['a'],
    );
    expect(events.filter((e) => e.mark === null)).toEqual([{ uid, ...removal }]);
    expect(queries[1]).toContain('b.class_id<>$2');
  });
  it('keeps them while another ficha of the student in the same diary shows the mark', async () => {
    // The Smecel lists a student twice and swaps the rows' order: the day moved to the other ficha.
    const { events, queries } = await run(
      [held('a', '2026-10-23')],
      {
        coverage: [{ recordKey: 'b', date: '2026-10-23', slots: [1, 2], complete: true }],
        marks: [{ recordKey: 'b', date: '2026-10-23', slot: 1, mark: 'X' }],
      },
      ['a', 'b'],
    );
    expect(events.filter((e) => e.mark === null)).toEqual([]);
    expect(queries).toHaveLength(1);
  });
  it('removes them when the other ficha has the day without the mark', async () => {
    const { events } = await run(
      [held('a', '2026-10-23')],
      {
        coverage: [
          { recordKey: 'a', date: '2026-10-24', slots: [1, 2], complete: true },
          { recordKey: 'b', date: '2026-10-23', slots: [1, 2], complete: true },
        ],
      },
      ['a', 'b'],
    );
    expect(events).toEqual([{ uid, ...removal }]);
  });
  it('keeps them for a student who also has a ficha in another class', async () => {
    const { events, queries } = await run(
      [held('a', '2026-10-23')],
      { coverage: [{ recordKey: 'a', date: '2026-10-22', slots: [1, 2], complete: true }] },
      ['a'],
      [uid],
    );
    expect(events).toEqual([]);
    expect(queries).toHaveLength(2);
  });
  it('proposes nothing for a ficha with no day at all in the collection', async () => {
    // A whole diary gone blank is far more likely a bad reading than a student without lessons.
    const { events, queries } = await run([held('a', '2026-10-23')], {}, ['a']);
    expect(events).toEqual([]);
    expect(queries).toHaveLength(1);
  });
  it('proposes nothing for a mark already removed or a day the record still has', async () => {
    const { events, queries } = await run(
      [{ ...held('a', '2026-10-23'), mark: null as unknown as string }, held('a', '2026-10-22')],
      { coverage: [{ recordKey: 'a', date: '2026-10-22', slots: [2], complete: false }] },
      ['a'],
    );
    expect(events).toEqual([]);
    expect(queries).toHaveLength(1);
  });
});
