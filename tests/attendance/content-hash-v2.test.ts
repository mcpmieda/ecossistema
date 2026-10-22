import { describe, expect, it } from 'vitest';
import {
  frequencyContentHashV2,
  frequencyScheduleHashV2,
} from '../../shared/attendance-contracts/frequency-v2';

/*
 * Reference values shared with the Windows collector (owner decision 22/10/2026): it computes the
 * same hashes in Python to skip a send when nothing changed. The collector's tests pin these exact
 * strings; a change here must change there too, or every collection would be sent in full (safe,
 * but the saving is lost).
 */
const CONTENT_HASH_VECTOR_V2 = {
  classId: 7,
  sourceClassId: '13331',
  sourceClassLabel: '6A 2026 - MATUTINO',
  rosterComplete: true,
  records: [
    { recordKey: 'source:a', originalName: 'JOÃO DA CONCEIÇÃO', originalClass: '6A 2026 - MATUTINO' },
    { recordKey: 'source:b', originalName: 'ÁGATA ÑANDU', originalClass: '6A 2026 - MATUTINO' },
  ],
  coverage: [
    { recordKey: 'source:a', date: '2026-10-20', slots: [1, 2, 3, 4, 5, 6], complete: true },
    { recordKey: 'source:b', date: '2026-10-20', slots: [1, 2, 3, 4, 5, 6], complete: false },
  ],
  marks: [{ recordKey: 'source:a', date: '2026-10-20', slot: 2, mark: 'X' as const }],
};
const SCHEDULE_HASH_VECTOR_V2 = {
  classId: 7,
  sourceClassId: '13331',
  sourceClassLabel: '6A 2026 - MATUTINO',
  lessons: [
    { weekday: 2, slot: 1, subject: 'CIENCIAS' },
    { weekday: 1, slot: 1, subject: 'ATIVIDADE DE VIDA DIÁRIA / PRÁTICA' },
  ],
};

describe('frequency content hashes shared with the collector', () => {
  it('pins the diary content hash', async () => {
    expect(await frequencyContentHashV2(CONTENT_HASH_VECTOR_V2)).toBe('ejvrOzgythGCyeAvblqIQp41cxV93nD11YHa99P6I6U');
  });
  it('pins the weekly grid hash, whatever the lessons order', async () => {
    expect(await frequencyScheduleHashV2(SCHEDULE_HASH_VECTOR_V2)).toBe('gvV54qYzWAbdp_6ZJk6hsRABYj-Vzb2dYc0XiRmTD6k');
    expect(
      await frequencyScheduleHashV2({
        ...SCHEDULE_HASH_VECTOR_V2,
        lessons: [...SCHEDULE_HASH_VECTOR_V2.lessons].reverse(),
      }),
    ).toBe('gvV54qYzWAbdp_6ZJk6hsRABYj-Vzb2dYc0XiRmTD6k');
  });
});
