import { EMPTY_CALENDAR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import {
  DEFAULT_RISK_V1,
  effectiveSettingsV1,
  type EffectiveSettingsV1,
} from '../../../../shared/student-portal-contracts/policy-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
export const SETTINGS_SCHOOL_V1 = { kind: 'school', academicYear: 2026 } as const;
export const SETTINGS_CLASS_V1 = { kind: 'class', academicYear: 2026, classId: 900001 } as const;
/** Fully invented configuration, not an institutional calendar or runtime seed. */
export function settingsFixtureV1(scope: ScopeV1 = SETTINGS_SCHOOL_V1): EffectiveSettingsV1 {
  const value = {
    accessEnabled: false,
    accessSchedule: null,
    showPartials: false,
    autoUpdate: false,
    showFinalResult: false,
    showTermClosing: false,
    termClosingConclusive: true,
    showFrequency: false,
    showSchedule: false,
    allowedPeriods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'],
    risk: { ...DEFAULT_RISK_V1 },
    calendar: structuredClone(EMPTY_CALENDAR_V1),
  };
  return effectiveSettingsV1.parse({
    scope,
    version: 7,
    value,
    sources: Object.fromEntries(Object.keys(value).map((key) => [key, SETTINGS_SCHOOL_V1])),
  });
}
