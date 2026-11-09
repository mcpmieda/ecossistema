// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PolicyLayoutV1 } from '../../../../src/features/student-portal-admin/settings/policy-layout-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';

/*
 * Owner request 23/10/2026: the Calendário policy opens read-only, so nothing changes by an
 * accidental click. "Editar" unlocks the calendar and the bells (their save buttons only exist
 * then); "Sair da edição" locks them again and discards unsaved drafts. The Horário switch has its
 * own tab since 09/11/2026 and is never locked.
 */
beforeEach(() => setupOperationsDomV1());
afterEach(cleanup);

const layout = (editable: boolean) => {
  let mounts = 0;
  const Editor = ({ editing, name }: { editing: boolean; name: string }) => {
    const [id] = useState(() => ++mounts); // A new id only on a new mount.
    return <p data-testid={name}>{`${name}:${editing ? 'edita' : 'lê'}:${id}`}</p>;
  };
  render(
    <PolicyLayoutV1
      disabled={false}
      calendarEditable={editable}
      field={(name) => <span key={name}>{`${name}:campo`}</span>}
      schoolCalendar={(editing) => <Editor editing={editing} name="calendario" />}
      schoolBells={(editing) => <Editor editing={editing} name="sinais" />}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
};

it('opens read-only and unlocks everything only after "Editar"', () => {
  layout(true);
  expect(screen.getByTestId('calendario').textContent).toMatch(/^calendario:lê/u);
  expect(screen.getByTestId('sinais').textContent).toMatch(/^sinais:lê/u);
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  expect(screen.getByTestId('calendario').textContent).toMatch(/^calendario:edita/u);
  expect(screen.getByTestId('sinais').textContent).toMatch(/^sinais:edita/u);
  expect(screen.getByText('Modo de edição')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
});

it('"Sair da edição" locks again and remounts the editors (unsaved drafts are discarded)', () => {
  layout(true);
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
  const mount = (text: string | null) => text?.split(':')[2];
  const before = mount(screen.getByTestId('calendario').textContent);
  fireEvent.click(screen.getByRole('button', { name: 'Sair da edição' }));
  const after = screen.getByTestId('calendario').textContent!;
  expect(after).toMatch(/^calendario:lê/u);
  expect(mount(after)).not.toBe(before);
  expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();
});

it('a person who cannot change the policies sees no "Editar"', () => {
  layout(false);
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
});

it('the Horário switch is in its own tab, not under the calendar (owner request 09/11/2026)', () => {
  layout(true);
  const calendarPanel = screen.getByTestId('calendario').closest('[role="tabpanel"]')!;
  expect(calendarPanel.textContent).not.toContain('showSchedule');
  fireEvent.click(screen.getByRole('tab', { name: 'Horário' }));
  const schedulePanel = screen.getByText('showSchedule:campo').closest('[role="tabpanel"]')!;
  expect(schedulePanel.querySelector('h2')?.textContent).toBe('Horário');
});
