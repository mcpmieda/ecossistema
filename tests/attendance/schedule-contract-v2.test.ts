// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { frequencyScheduleV2 } from '../../shared/attendance-contracts/frequency-v2';

// Every 15 minutes from 07:00 to 18:45: what the Coletor's "Em intervalos" can produce.
const times = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const minutes = 7 * 60 + i * 15;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  });

const schedule = (dayTimes: string[], recheck: string | null = null) => ({
  timezone: 'America/Bahia',
  rules: Array.from({ length: 14 }, (_, i) => ({
    weekday: Math.floor(i / 2),
    shift: i % 2 ? 'vespertino' : 'matutino',
    enabled: true,
    times: dayTimes,
    recheck,
  })),
});

describe('frequencyScheduleV2 daily limit', () => {
  it('accepts up to 48 collections per rule', () => {
    expect(frequencyScheduleV2.safeParse(schedule(times(48))).success).toBe(true);
    expect(frequencyScheduleV2.safeParse(schedule(times(47), '23:30')).success).toBe(true);
  });

  it('rejects more than 48 collections per rule, recheck included', () => {
    expect(frequencyScheduleV2.safeParse(schedule(times(49))).success).toBe(false);
    expect(frequencyScheduleV2.safeParse(schedule(times(48), '23:30')).success).toBe(false);
  });
});
