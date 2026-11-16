// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  resolveRelationalClosingUpdateV9,
  type RelationalClosingStateV9,
} from '../../../server/gradebook/application/import/import-relational-closing-v9';

function state(overrides: Partial<RelationalClosingStateV9> = {}): RelationalClosingStateV9 {
  return {
    exists: true,
    am: [null, null, null],
    rec: [null, null, null],
    ncMask: 0,
    rrMask: 0,
    u: null,
    ...overrides,
  };
}

describe('relational closing update V9', () => {
  it('treats unavailable AM/REC/U as a no-op', () => {
    const current = state({
      am: [1000, 2000, 3000],
      rec: [4000, null, 6000],
      ncMask: 2,
      u: 7000,
    });

    const result = resolveRelationalClosingUpdateV9(current, {
      am: [['u'], undefined, ['u']],
      rec: [['u'], ['u'], ['u']],
      u: ['u'],
    });

    expect(result).toEqual({
      next: current,
      changes: [],
      empty: false,
    });
  });

  it('tracks AM and annual source changes with their historical fields', () => {
    const result = resolveRelationalClosingUpdateV9(state(), {
      am: [12000, null, 24000],
      u: 60000,
    });

    expect(result.next).toMatchObject({
      am: [12000, null, 24000],
      rec: [null, null, null],
      ncMask: 0,
      rrMask: 0,
      u: 60000,
    });
    expect(result.changes).toEqual([
      { campo: 1, oldValue: null, newValue: 12000, oldState: 0, newState: 1 },
      { campo: 3, oldValue: null, newValue: 24000, oldState: 0, newState: 1 },
      { campo: 7, oldValue: null, newValue: 60000, oldState: 0, newState: 1 },
    ]);
    expect(result.empty).toBe(false);
  });

  it('keeps N/C and R/R masks disjoint while recording exact recovery states', () => {
    const result = resolveRelationalClosingUpdateV9(state({ rec: [5000, null, 7000] }), {
      rec: [['n'], ['r'], null],
    });

    expect(result.next).toMatchObject({
      rec: [null, null, null],
      ncMask: 1,
      rrMask: 2,
    });
    expect(result.changes).toEqual([
      { campo: 4, oldValue: 5000, newValue: null, oldState: 1, newState: 2 },
      { campo: 5, oldValue: null, newValue: null, oldState: 0, newState: 3 },
      { campo: 6, oldValue: 7000, newValue: null, oldState: 1, newState: 0 },
    ]);
  });

  it('clears marker masks when recovery returns to numeric or empty', () => {
    const result = resolveRelationalClosingUpdateV9(
      state({
        rec: [null, null, 9000],
        ncMask: 1,
        rrMask: 2,
      }),
      { rec: [6000, null, ['u']] },
    );

    expect(result.next).toMatchObject({
      rec: [6000, null, 9000],
      ncMask: 0,
      rrMask: 0,
    });
    expect(result.changes).toEqual([
      { campo: 4, oldValue: null, newValue: 6000, oldState: 2, newState: 1 },
      { campo: 5, oldValue: null, newValue: null, oldState: 3, newState: 0 },
    ]);
  });

  it('marks a fully cleared closing as empty without changing existence metadata', () => {
    const result = resolveRelationalClosingUpdateV9(
      state({
        am: [1000, null, null],
        u: 2000,
      }),
      { am: [null], u: null },
    );

    expect(result.next).toEqual({
      exists: true,
      am: [null, null, null],
      rec: [null, null, null],
      ncMask: 0,
      rrMask: 0,
      u: null,
    });
    expect(result.changes).toEqual([
      { campo: 1, oldValue: 1000, newValue: null, oldState: 1, newState: 0 },
      { campo: 7, oldValue: 2000, newValue: null, oldState: 1, newState: 0 },
    ]);
    expect(result.empty).toBe(true);
  });
});
