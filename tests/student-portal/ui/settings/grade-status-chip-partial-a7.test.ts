import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { GradeStatusChipV1 } from '../../../../src/features/student-portal-admin/settings/grades-tab-v1';
import { effectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import { settingsFixtureV1 } from './fixtures-v1';

afterEach(cleanup);

/** Every period shown now (agenda switched on, no scheduled change). */
function shownSettingsA7() {
  const settings = settingsFixtureV1();
  const open = { enabled: true, schedule: [] };
  return effectiveSettingsV1.parse({
    ...settings,
    value: {
      ...settings.value,
      calendar: {
        ...settings.value.calendar,
        disclosure: { mode: 'agenda', periods: { T1: open, T2: open, T3: open, REC1: open, REC2: open, REC3: open } },
      },
    },
  });
}

it('A7: the Aba Notas chip never says "Os alunos veem agora" for a partial publication', () => {
  const settings = shownSettingsA7();
  render(createElement(GradeStatusChipV1, { settings, period: 'T1', state: 'published', partial: { published: 3, total: 40 } }));
  expect(screen.queryByText(/Os alunos veem agora/)).toBeNull();
  expect(screen.getByText(/Só 3 de 40 alunos veem agora/)).toBeTruthy();
});

it('A7: a full publication keeps "Os alunos veem agora"', () => {
  const settings = shownSettingsA7();
  render(createElement(GradeStatusChipV1, { settings, period: 'T1', state: 'published', partial: null }));
  expect(screen.getByText(/Os alunos veem agora/)).toBeTruthy();
});
