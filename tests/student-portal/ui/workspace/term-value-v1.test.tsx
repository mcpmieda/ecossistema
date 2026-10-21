// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudentPortalWorkspaceV1 } from '../../../../src/features/student-portal/workspace/student-workspace-v1';
import { gradesFixtureV1, score } from '../grades/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';

/*
 * "vale 30 · 18 passa" (owner request 20/10/2026) states the 60% line. PR 1317 review: the
 * school's minimum comes from the server (meetsMinimum), so "passa" is only shown while every
 * published trimester mark agrees with 60%; otherwise the tab reads "vale 30" only.
 */
beforeEach(() => {
  setupOperationsDomV1();
  window.history.replaceState(null, '', window.location.href);
});
afterEach(cleanup);

const termValueText = () => document.querySelector('.pa-term-value')?.textContent;

describe('trimester value under the Boletim tab', () => {
  it('states the passing mark when the published marks follow 60%', () => {
    const data = gradesFixtureV1(false);
    for (const subject of data.subjects)
      for (const period of subject.periods)
        if (period.final.kind === 'score' && period.final.maximum)
          period.final = score(period.final.value, period.final.maximum, period.final.value * 100 >= period.final.maximum * 60);
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(termValueText()).toBe('vale 30 · 18 passa');
  });

  it('a school with another minimum (22,5 of 30 needed) shows only what the trimester is worth', () => {
    // The shared fixture: 22,499/30 below the minimum and 22,5/30 above it, i.e. a 75% minimum.
    render(<StudentPortalWorkspaceV1 data={gradesFixtureV1(false)} profile={null} />);
    expect(termValueText()).toBe('vale 30');
  });
});
