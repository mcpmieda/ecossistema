import { settingsValueV1, type EffectiveSettingsV1 } from '../../../shared/student-portal-contracts/policy-v1';
import type { PolicyScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import {
  combineAccessPlansV1,
  legacyAccessPlanV1,
  type AccessPlanV1,
} from '../../../shared/student-portal-contracts/access-schedule-v1';
import type { PolicyValueV1 } from './calendar-v1';

const scopeKeyV1 = (scope: PolicyScopeV1) => {
  if (scope.kind === 'school') {
    return 'school';
  }
  if (scope.kind === 'class') {
    return `class:${scope.classId}`;
  }
  if (scope.kind === 'shift') {
    return `shift:${scope.shift}`;
  }
  return `account:${scope.accountId.toLowerCase()}`;
};

/** The level's own plan, or null for a level still on the Calendário access window. */
function scheduledPlanV1(value: PolicyValueV1): AccessPlanV1 | null {
  return value.accessSchedule === null
    ? null
    : { enabled: value.accessEnabled, schedule: value.accessSchedule };
}

function planOfV1(value: PolicyValueV1): AccessPlanV1 {
  return (
    scheduledPlanV1(value) ??
    legacyAccessPlanV1(
      value.accessEnabled,
      value.calendar.accessStartsAt ?? value.calendar.yearStartsAt,
      value.calendar.accessEndsAt ?? value.calendar.yearEndsAt,
    )
  );
}

/**
 * Runtime barrier only: stored overrides and their editing provenance stay intact.
 *
 * Without any schedule this is the original window intersection. Once the school or the level
 * that decides a student's access (class or student) has schedules, the result is one exact plan
 * in `accessEnabled` + `accessSchedule`: open only while both are open.
 */
export function enforceSchoolAccessV1(
  input: PolicyValueV1 | Pick<EffectiveSettingsV1, 'value' | 'sources'>,
  school: PolicyValueV1,
): PolicyValueV1 {
  type EffectiveV1 = Pick<EffectiveSettingsV1, 'value' | 'sources'>;
  const effective = 'sources' in input ? (input as EffectiveV1) : null;
  const local: PolicyValueV1 = effective ? effective.value : (input as PolicyValueV1);
  // The switch and its schedule are one unit: a schedule inherited from another level than the
  // switch never acts on it.
  const localValue: PolicyValueV1 =
    effective &&
    local.accessSchedule !== null &&
    scopeKeyV1(effective.sources.accessSchedule) !== scopeKeyV1(effective.sources.accessEnabled)
      ? { ...local, accessSchedule: null }
      : local;
  if (localValue.accessSchedule !== null || school.accessSchedule !== null) {
    const combined = combineAccessPlansV1(planOfV1(school), planOfV1(localValue));
    // The old window is already inside the combined plan; leaving it would suggest it still acts.
    const calendar = { ...localValue.calendar };
    delete calendar.accessStartsAt;
    delete calendar.accessEndsAt;
    return settingsValueV1.parse({
      ...localValue,
      accessEnabled: combined.enabled,
      accessSchedule: combined.schedule,
      calendar,
    });
  }
  const bounds = (value: PolicyValueV1) =>
    [
      value.calendar.accessStartsAt ?? value.calendar.yearStartsAt,
      value.calendar.accessEndsAt ?? value.calendar.yearEndsAt,
    ] as const;
  const [localStart, localEnd] = bounds(localValue);
  const [schoolStart, schoolEnd] = bounds(school);
  if (!school.accessEnabled || !localStart || !localEnd || !schoolStart || !schoolEnd)
    return { ...localValue, accessEnabled: false };
  const start = Math.max(Date.parse(localStart), Date.parse(schoolStart));
  const end = Math.min(Date.parse(localEnd), Date.parse(schoolEnd));
  if (end <= start) return { ...localValue, accessEnabled: false };
  return settingsValueV1.parse({
    ...localValue,
    calendar: {
      ...localValue.calendar,
      accessStartsAt: new Date(start).toISOString(),
      accessEndsAt: new Date(end).toISOString(),
    },
  });
}
