import { describe, expect, it } from 'vitest';
import {
  rankingCutV5,
  rankingPlacesV5,
} from '../../../shared/gradebook-contracts/performance/performance-dashboard-v5';

describe('ranking with equal totals v1', () => {
  it('equal totals share a place and the next one skips as many', () => {
    expect(rankingPlacesV5([300, 290, 290, 280])).toEqual([1, 2, 2, 4]);
    expect(rankingPlacesV5([300, 300, 300, 250, 250, 200])).toEqual([1, 1, 1, 4, 4, 6]);
    expect(rankingPlacesV5([10n, 10n, 9n])).toEqual([1, 1, 3]);
    expect(rankingPlacesV5([])).toEqual([]);
  });

  it('keeps every student tied at the tenth place', () => {
    const totals = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 11, 11, 10];
    const top = rankingCutV5(totals, (total) => total);
    expect(top).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 11, 11]);
  });

  it('stops at ten places when nobody ties across the cut', () => {
    const totals = Array.from({ length: 14 }, (_, index) => 100 - index);
    expect(rankingCutV5(totals, (total) => total)).toHaveLength(10);
  });

  it('a tie above the tenth place pushes later students out', () => {
    // Nine students share first place: the tenth has the tenth place, the eleventh does not.
    const totals = [...Array.from({ length: 9 }, () => 50), 40, 30];
    expect(rankingPlacesV5(totals).slice(-2)).toEqual([10, 11]);
    expect(rankingCutV5(totals, (total) => total)).toHaveLength(10);
  });
});
