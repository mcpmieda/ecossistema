import { z } from 'zod';
import { instantV1 } from './core-v1';

/*
 * Agendamentos de acesso (owner decisions 2026-09-27). Each level (school, class, student) may keep
 * its own access: a switch plus scheduled "Abrir"/"Fechar" actions. The Portal follows the agenda:
 * before a scheduled action it is in the opposite state — an "Abrir" later closes it now and opens
 * it then; a "Fechar" later opens it now and closes it then. After the last action it stays as that
 * action left it, and with no actions it is what the switch says.
 *
 * The school still prevails: a student may enter only while both the school and the student's own
 * level (class or student, when they have one) are open.
 */
const accessActionV1 = z.enum(['open', 'close']);
export const accessEventV1 = z.object({ at: instantV1, action: accessActionV1 }).strict();
export const accessScheduleV1 = z
  .array(accessEventV1)
  .max(40)
  .refine(
    (events) => events.every((event, index) => index === 0 || Date.parse(events[index - 1]!.at) < Date.parse(event.at)),
    'Access schedule must be in time order without repeated times',
  );
export type AccessEventV1 = z.infer<typeof accessEventV1>;

/** `enabled` is the switch as saved; the schedule acts on it from each event's time. */
export type AccessPlanV1 = { readonly enabled: boolean; readonly schedule: readonly AccessEventV1[] };

/**
 * Open at `time`. An action applies from its own instant; until then the Portal waits in the
 * opposite state. After the last action it keeps that action's state; with none, the switch.
 */
export function accessOpenAtV1(plan: AccessPlanV1, time: number): boolean {
  let last: AccessEventV1 | undefined;
  for (const event of plan.schedule) {
    if (Date.parse(event.at) > time) return event.action !== 'open';
    last = event;
  }
  return last ? last.action === 'open' : plan.enabled;
}

/** First instant after `time` at which the plan becomes `open` (true) or closed (false). */
export function nextAccessChangeV1(plan: AccessPlanV1, time: number, open: boolean): number | null {
  // The state only changes at an action's instant, so checking each future action is enough.
  let current = accessOpenAtV1(plan, time);
  for (const event of plan.schedule) {
    const at = Date.parse(event.at);
    if (at <= time) continue;
    const state = accessOpenAtV1(plan, at);
    if (state === current) continue;
    if (state === open) return at;
    current = state;
  }
  return null;
}

/**
 * Using the switch while actions are scheduled brings the next ones forward: the actions that
 * would contradict the new state now are removed, and the later ones keep their times.
 */
export function anticipateAccessV1(plan: AccessPlanV1, time: number, open: boolean): AccessPlanV1 {
  let schedule = plan.schedule.filter((event) => Date.parse(event.at) > time);
  while (schedule.length > 0 && accessOpenAtV1({ enabled: open, schedule }, time) !== open)
    schedule = schedule.slice(1);
  return { enabled: open, schedule };
}

/** Both open at once: the school barrier over a class or student plan, as a single exact plan. */
export function combineAccessPlansV1(left: AccessPlanV1, right: AccessPlanV1): AccessPlanV1 {
  const times = [...new Set([...left.schedule, ...right.schedule].map((event) => Date.parse(event.at)))].sort(
    (a, b) => a - b,
  );
  const both = (time: number) => accessOpenAtV1(left, time) && accessOpenAtV1(right, time);
  // Only real changes become actions: before an action the result must be its opposite state.
  const initial = times.length ? both(times[0]! - 1) : left.enabled && right.enabled;
  const schedule: AccessEventV1[] = [];
  let state = initial;
  for (const time of times) {
    const next = both(time);
    if (next === state) continue;
    schedule.push({ at: new Date(time).toISOString(), action: next ? 'open' : 'close' });
    state = next;
  }
  return { enabled: initial, schedule };
}

/**
 * The old "Quando o aluno pode entrar" window as a plan: closed until it starts, open inside it,
 * closed from its end. Without the switch, or without both ends, it never opens.
 */
export function legacyAccessPlanV1(
  enabled: boolean,
  start: string | null | undefined,
  end: string | null | undefined,
): AccessPlanV1 {
  if (!enabled || !start || !end || Date.parse(end) <= Date.parse(start))
    return { enabled: false, schedule: [] };
  return {
    enabled: false,
    schedule: [
      { at: new Date(Date.parse(start)).toISOString(), action: 'open' },
      { at: new Date(Date.parse(end)).toISOString(), action: 'close' },
    ],
  };
}

/** How the admin saves a plan: the switch holds the state now; only future actions remain. */
export function settleAccessPlanV1(plan: AccessPlanV1, time: number): AccessPlanV1 {
  return {
    enabled: accessOpenAtV1(plan, time),
    schedule: plan.schedule.filter((event) => Date.parse(event.at) > time),
  };
}
