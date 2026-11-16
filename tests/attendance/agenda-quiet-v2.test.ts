// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { agendaNearV2, onlineSecondsV2, ONLINE_QUIET_SECONDS_V2 } from '../../server/attendance/agenda-quiet-v2';
import type { FrequencyReportScheduleV2, FrequencyScheduleV2 } from '../../shared/attendance-contracts/frequency-v2';

// Monday 16/11/2026 07:30 in America/Bahia (UTC−3) = 10:30 UTC.
const SLOT = Date.UTC(2026, 10, 16, 10, 30);
const schedule: FrequencyScheduleV2 = {
  timezone: 'America/Bahia',
  rules: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => (['matutino', 'vespertino'] as const).map((shift) => ({
    weekday, shift, enabled: weekday === 1 && shift === 'matutino', times: weekday === 1 && shift === 'matutino' ? ['07:30'] : [], recheck: null,
  }))),
};

describe('agenda quieta do Coletor (issue #1426, 6B)', () => {
  it('perto da agenda: de 10 min antes a 5 min depois de cada horário', () => {
    expect(agendaNearV2(schedule, null, SLOT - 600_000)).toBe(true);
    expect(agendaNearV2(schedule, null, SLOT - 601_000)).toBe(false);
    expect(agendaNearV2(schedule, null, SLOT + 300_000)).toBe(true);
    expect(agendaNearV2(schedule, null, SLOT + 301_000)).toBe(false);
    // O mesmo horário na terça não tem coleta.
    expect(agendaNearV2(schedule, null, SLOT + 86_400_000)).toBe(false);
  });

  it('o relatório de alunos também conta', () => {
    const report: FrequencyReportScheduleV2 = { timezone: 'America/Bahia', enabled: true, every: 60, from: '13:00', to: '15:00', weekdays: [1] };
    expect(agendaNearV2(null, report, Date.UTC(2026, 10, 16, 17, 55))).toBe(true); // 14:55 local
    expect(agendaNearV2(null, report, Date.UTC(2026, 10, 16, 17, 30))).toBe(false);
    expect(agendaNearV2(null, { ...report, enabled: false }, Date.UTC(2026, 10, 16, 17, 55))).toBe(false);
  });

  it('longe da agenda, o computador visto há até 17 min continua ligado', () => {
    expect(onlineSecondsV2(schedule, null, SLOT)).toBe(120);
    expect(onlineSecondsV2(schedule, null, SLOT - 3_600_000)).toBe(ONLINE_QUIET_SECONDS_V2);
    expect(onlineSecondsV2(null, null, SLOT)).toBe(ONLINE_QUIET_SECONDS_V2);
  });
});
