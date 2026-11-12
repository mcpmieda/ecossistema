import { describe, expect, it } from 'vitest';
import { createViewPreferencesServiceV1 } from '../../../server/gradebook/application/settings/view-preferences-v1';
import { viewPreferencesSaveSchemaV1 } from '../../../shared/gradebook-contracts/settings/view-preferences-v1';

const ACTOR = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

/** In-memory stand-in for admin_preferences.view_state_v1, answering the service's statements. */
function fakeDatabase() {
  const rows: { actor: string; key: string; value: string; at: number }[] = [];
  let clock = 0;
  const port = {
    async query<Row extends Record<string, unknown>>(_text: string, parameters: readonly unknown[]) {
      const [actor, limit] = parameters as [string, number];
      return rows
        .filter((row) => row.actor === actor)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((row) => ({ view_key: row.key, view_value: row.value }) as unknown as Row);
    },
    async executeNative(text: string, parameters: readonly unknown[]) {
      const actor = parameters[0] as string;
      if (text.trimStart().startsWith('INSERT')) {
        const views = JSON.parse((parameters[1] as { jsonText: string }).jsonText) as Record<string, unknown>;
        for (const [key, value] of Object.entries(views)) {
          const existing = rows.find((row) => row.actor === actor && row.key === key);
          clock += 1;
          if (existing) Object.assign(existing, { value: JSON.stringify(value), at: clock });
          else rows.push({ actor, key, value: JSON.stringify(value), at: clock });
        }
      } else {
        const keep = parameters[1] as number;
        const mine = rows.filter((row) => row.actor === actor).sort((a, b) => b.at - a.at);
        for (const row of mine.slice(keep)) rows.splice(rows.indexOf(row), 1);
      }
      return { rows: [], changes: 0 };
    },
  };
  return { port, rows };
}

describe('view preferences v1', () => {
  it('saves and reads back each account separately', async () => {
    const { port } = fakeDatabase();
    const service = createViewPreferencesServiceV1(port);
    const view = { perspective: 'notes', selection: { studentId: null, offerId: 4, teacherId: null }, year: 2026 };
    await service.save(ACTOR, { views: { 'gradebook-performance-view': view, 'platform-address': '#/banco-de-notas?area=performance' } });
    await service.save(OTHER, { views: { 'platform-address': '#/importacao' } });

    expect(await service.read(ACTOR)).toEqual({
      contractVersion: 1,
      state: 'ready',
      views: { 'gradebook-performance-view': view, 'platform-address': '#/banco-de-notas?area=performance' },
    });
    expect(await service.read(OTHER)).toEqual({
      contractVersion: 1, state: 'ready', views: { 'platform-address': '#/importacao' },
    });
  });

  it('replaces a view with the latest choice', async () => {
    const { port } = fakeDatabase();
    const service = createViewPreferencesServiceV1(port);
    await service.save(ACTOR, { views: { 'gradebook-performance-filters:2026': { period: 1 } } });
    const saved = await service.save(ACTOR, { views: { 'gradebook-performance-filters:2026': { period: 2 } } });
    expect(saved).toEqual({
      contractVersion: 1, state: 'ready', views: { 'gradebook-performance-filters:2026': { period: 2 } },
    });
  });

  it('keeps at most 64 views per account, the most recent ones', async () => {
    const { port, rows } = fakeDatabase();
    const service = createViewPreferencesServiceV1(port);
    for (let index = 0; index < 70; index += 1) await service.save(ACTOR, { views: { [`view-${index}`]: index } });
    expect(rows).toHaveLength(64);
    expect(rows.some((row) => row.key === 'view-0')).toBe(false);
    expect(rows.some((row) => row.key === 'view-69')).toBe(true);
  });

  it('refuses malformed keys, oversized values and a session without an account id', async () => {
    const service = createViewPreferencesServiceV1(fakeDatabase().port);
    expect((await service.save(ACTOR, { views: { 'Bad Key': 1 } })).state).toBe('invalid-request');
    expect((await service.save(ACTOR, { views: { big: 'x'.repeat(3000) } })).state).toBe('invalid-request');
    expect((await service.save(ACTOR, { views: {} })).state).toBe('invalid-request');
    expect((await service.save(ACTOR, { views: { a: 1 }, extra: true })).state).toBe('invalid-request');
    expect((await service.read('not-a-uuid')).state).toBe('not-authorized');
  });

  it('answers unavailable when the database fails', async () => {
    const failing = {
      query: () => Promise.reject(new Error('down')),
      executeNative: () => Promise.reject(new Error('down')),
    };
    const service = createViewPreferencesServiceV1(failing);
    expect((await service.read(ACTOR)).state).toBe('unavailable');
    expect((await service.save(ACTOR, { views: { a: 1 } })).state).toBe('unavailable');
  });

  it('accepts the keys the screens already use', () => {
    for (const key of ['gradebook-performance-view', 'gradebook-performance-filters:2026',
      'gradebook-bulletins-view', 'gradebook-council-view', 'platform-address'])
      expect(viewPreferencesSaveSchemaV1.safeParse({ views: { [key]: 1 } }).success).toBe(true);
  });
});
