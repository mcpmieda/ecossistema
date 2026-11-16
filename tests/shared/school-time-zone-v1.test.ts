// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { calendarV1 } from '../../shared/student-portal-contracts/policy-v1';
import { EMPTY_CALENDAR_V1 } from '../../shared/student-portal-contracts/fixtures-v1';
import { SCHOOL_TIME_ZONE_V1 } from '../../shared/school-time-zone-v1';

it('o calendário salvo antes de 14/11/2026 (São Paulo) é lido no fuso da escola', () => {
  expect(calendarV1.parse({ ...EMPTY_CALENDAR_V1, timezone: 'America/Sao_Paulo' }).timezone).toBe(SCHOOL_TIME_ZONE_V1);
  expect(calendarV1.parse({ ...EMPTY_CALENDAR_V1, timezone: 'America/Bahia' }).timezone).toBe(SCHOOL_TIME_ZONE_V1);
  expect(() => calendarV1.parse({ ...EMPTY_CALENDAR_V1, timezone: 'UTC' })).toThrow();
});

it('o código só nomeia o fuso numa fonte (issue #1426, 41)', () => {
  const hits = execFileSync('git', ['grep', '-lE', "'America/(Sao_Paulo|Bahia)'", '--', 'server', 'src', 'shared', 'workers'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  expect(hits).toEqual(['shared/school-time-zone-v1.ts']);
});
