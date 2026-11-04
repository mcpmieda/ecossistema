// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EMPTY_CALENDAR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import {
  calendarDraftV1,
  parseCalendarDraftV1,
} from '../../../../src/features/student-portal-admin/settings/calendar-draft-v1';
import {
  calendarInputV1,
  calendarChangeLabelV1,
  calendarInstantV1,
  changedPastDatesV1,
  settingsScopeKeyV1,
  singleSettingV1,
} from '../../../../src/features/student-portal-admin/settings/settings-values-v1';

describe('settings drafts keep the contract and São Paulo time', () => {
  it('round-trips São Paulo across UTC midnight with second precision, independently of the host timezone', () => {
    expect(calendarInputV1('2026-09-14T01:02:03Z')).toBe('2026-09-13T22:02:03');
    expect(calendarInstantV1('2026-09-13T22:02:03')).toBe('2026-09-14T01:02:03Z');
    expect(calendarInstantV1('2026-09-13T22:02')).toBe('2026-09-14T01:02:00Z');
    expect(calendarInstantV1('')).toBeNull();
  });
  it('rejects normalized invalid dates, partial input and fractional seconds', () => {
    for (const input of [
      '2026-02-30T12:00',
      '2026-09',
      '2026-09-13T25:00',
      '2026-09-13T12:00:00.1',
    ])
      expect(() => calendarInstantV1(input)).toThrow();
  });
  it('does not infer any institutional dates from an empty calendar', () => {
    expect(parseCalendarDraftV1(calendarDraftV1(EMPTY_CALENDAR_V1))).toEqual(EMPTY_CALENDAR_V1);
  });
  it('uses the shared schema for chronology and allows null draft milestones', () => {
    const draft = calendarDraftV1(EMPTY_CALENDAR_V1);
    draft.dates.yearStartsAt = '2026-03-01T00:00';
    draft.dates.t1EndsAt = '2026-02-01T00:00';
    expect(() => parseCalendarDraftV1(draft)).toThrow();
    draft.dates.t1EndsAt = '';
    draft.dates.finalDisclosureAt = '2026-12-23T08:00';
    expect(parseCalendarDraftV1(draft).finalDisclosureAt).toBe('2026-12-23T11:00:00Z');
  });
  it('reports changed past dates for review, including removal, without deciding access', () => {
    const previous = { ...EMPTY_CALENDAR_V1, yearStartsAt: '2026-02-23T03:00:00Z' };
    expect(
      changedPastDatesV1(previous, EMPTY_CALENDAR_V1, Date.parse('2026-09-13T12:00:00Z')),
    ).toEqual(['yearStartsAt']);
  });
  it('names removed disclosure end dates as hiding notes rather than exposing internal keys', () => {
    const previous = {
      ...EMPTY_CALENDAR_V1,
      disclosure: {
        mode: 'single' as const,
        at: '2026-08-01T03:00:00Z',
        endsAt: '2026-08-30T03:00:00Z',
        periods: ['T1' as const],
      },
    };
    const changes = changedPastDatesV1(
      previous,
      EMPTY_CALENDAR_V1,
      Date.parse('2026-09-13T12:00:00Z'),
    );
    expect(changes.map(calendarChangeLabelV1)).toContain('Ocultar notas em');
    expect(calendarChangeLabelV1('disclosure.endsAt.T1')).toBe('Ocultar notas do 1º trimestre');
    expect(calendarChangeLabelV1('disclosure.REC2')).toBe('Divulgação da recuperação 2');
    expect(calendarChangeLabelV1('accessEndsAt')).toBe('Encerrar acesso em');
  });
  it('keeps false and empty periods as explicit overrides and risk/calendar atomic', () => {
    expect(singleSettingV1('accessEnabled', false)).toEqual({ accessEnabled: false });
    expect(singleSettingV1('allowedPeriods', [])).toEqual({ allowedPeriods: [] });
    expect(() => singleSettingV1('calendar', { yearStartsAt: null })).toThrow();
    expect(() => singleSettingV1('risk', { challengeAfter: 3 })).toThrow();
  });
  it('rejects another academic year at the scope boundary', () => {
    expect(() => settingsScopeKeyV1({ kind: 'school', academicYear: 2025 } as never)).toThrow();
  });
});
