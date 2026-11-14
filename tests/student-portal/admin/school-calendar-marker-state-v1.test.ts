// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { markerStateV1 } from '../../../src/features/student-portal-admin/settings/school-calendar-editor-v1';

type Markers = NonNullable<Parameters<typeof markerStateV1>[0]>;
type Policy = NonNullable<Parameters<typeof markerStateV1>[1]>;

describe('the main dates of the school calendar on screen', () => {
  it('nothing read yet: nothing changed, nothing pending', () => {
    expect(markerStateV1(null, null)).toEqual({ changed: false, pending: [], past: [] });
  });

  it('none marked: every main date is pending; without the policy nothing counts as changed', () => {
    const markers = {} as Markers;
    const state = markerStateV1(markers, null);
    expect(state.changed).toBe(false);
    expect(state.pending.length).toBeGreaterThan(0);
    expect(state.past).toEqual([]);
  });

  it('the same dates as the policy: not changed, so nothing is asked about past dates', () => {
    const markers = {} as Markers;
    const policy = { calendar: {}, markers: {} } as unknown as Policy;
    expect(markerStateV1(markers, policy)).toMatchObject({ changed: false, past: [] });
  });
});
