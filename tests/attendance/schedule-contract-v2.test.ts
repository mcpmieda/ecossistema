// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { frequencyScheduleV2, frequencyScheduleWriteV2 } from '../../shared/attendance-contracts/frequency-v2';

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

const rules = (fill: (i: number) => { enabled: boolean; times: string[]; recheck: string | null }) => ({
  timezone: 'America/Bahia',
  rules: Array.from({ length: 14 }, (_, i) => ({
    weekday: Math.floor(i / 2),
    shift: i % 2 ? 'vespertino' : 'matutino',
    ...fill(i),
  })),
});
const off = { enabled: false, times: [], recheck: null };

describe('frequencyScheduleWriteV2 (what a save may write)', () => {
  it('accepts the 48 per day budget when both shifts share the same moments', () => {
    expect(frequencyScheduleWriteV2.safeParse(schedule(times(48))).success).toBe(true);
  });

  it('rejects 96 distinct moments in one day across the two shifts', () => {
    const late = times(48).map(t => `${String(Number(t.slice(0, 2)) + 12).padStart(2, '0')}${t.slice(2)}`);
    const value = rules(i => (i === 2 ? { enabled: true, times: times(48), recheck: null }
      : i === 3 ? { enabled: true, times: late.filter(t => t < '24'), recheck: null } : off));
    expect(frequencyScheduleV2.safeParse(value).success).toBe(true); // Still readable.
    expect(frequencyScheduleWriteV2.safeParse(value).success).toBe(false);
  });

  it('rejects an enabled shift without any moment, accepts a disabled empty one and a recheck-only one', () => {
    expect(frequencyScheduleWriteV2.safeParse(rules(i => (i === 2 ? { enabled: true, times: [], recheck: null } : off))).success).toBe(false);
    expect(frequencyScheduleWriteV2.safeParse(rules(() => off)).success).toBe(true);
    expect(frequencyScheduleWriteV2.safeParse(rules(i => (i === 2 ? { enabled: true, times: [], recheck: '18:30' } : off))).success).toBe(true);
  });

  it('requires at least 5 minutes between moments of the same day', () => {
    const dense = rules(i => (i === 2 ? { enabled: true, times: ['07:00', '07:04'], recheck: null } : off));
    const spaced = rules(i => (i === 2 ? { enabled: true, times: ['07:00', '07:05'], recheck: null } : off));
    const result = frequencyScheduleWriteV2.safeParse(dense);
    expect(result.success).toBe(false);
    // The message names the day so the administrator finds it among the 14 rules.
    expect(result.error?.issues.map(issue => issue.message)).toContain('Segunda-feira: deixe pelo menos 5 minutos entre as coletas.');
    expect(frequencyScheduleWriteV2.safeParse(spaced).success).toBe(true);
  });
});
