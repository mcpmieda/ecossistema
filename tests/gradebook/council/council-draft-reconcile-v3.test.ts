// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reconcileDraftV3 } from '../../../src/features/gradebook/council/relational-council-page-v3';

describe('a council draft after the record is read again', () => {
  it('record unchanged: the draft stays; it is dirty only when it differs from the record', () => {
    expect(reconcileDraftV3('A', 'A', 'A')).toEqual({ reset: false, kept: false, dirty: false });
    expect(reconcileDraftV3('A', 'A', 'typed')).toEqual({ reset: false, kept: false, dirty: true });
  });

  it('record changed elsewhere with no draft of mine: the new record is shown', () => {
    expect(reconcileDraftV3('A', 'B', 'A')).toEqual({ reset: true, kept: false, dirty: false });
    expect(reconcileDraftV3('A', 'B', 'B')).toEqual({ reset: true, kept: false, dirty: false });
  });

  it('record changed elsewhere while I typed: my draft is kept and stays dirty', () => {
    expect(reconcileDraftV3('A', 'B', 'typed')).toEqual({ reset: false, kept: true, dirty: true });
  });
});
