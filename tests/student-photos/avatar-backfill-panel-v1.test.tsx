import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AvatarBackfillPanelV1 } from '../../src/features/student-photos/avatar-backfill-panel-v1';
import { PhotoAdminClientErrorV1 } from '../../src/features/student-photos/admin-client-v1';
import { StudentAccountsV1 } from '../../src/features/student-portal-admin/accounts/student-accounts-v1';
import { accountsMockV1 } from '../student-portal/ui/accounts/fixtures-v1';
import {
  backfillIdV1 as id,
  backfillPortsV1 as ports,
  backfillReferenceV1 as reference,
  backfillSubjectV1 as subject,
} from './avatar-backfill-fixture-v1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
const start = () => screen.getByRole('button', { name: 'Gerar miniaturas que faltam' });

it('runs only on request and reports what was created, what existed and what has no photo', async () => {
  const { value, spies } = ports((who) =>
    reference(who) === id(2)
      ? { hasAvatar: true }
      : reference(who) === id(3)
        ? { hasPortrait: false }
        : {},
  );
  render(<AvatarBackfillPanelV1 subjects={[1, 2, 3, 4].map(subject)} ready ports={value} />);
  expect(spies.catalog).not.toHaveBeenCalled();
  await userEvent.setup().click(start());
  expect(
    await screen.findByText('4 de 4 alunos · 2 criadas · 1 já existiam · 1 sem foto'),
  ).toBeTruthy();
  expect(spies.client.save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(start()).toBeTruthy());
});

it('waits for the complete list and tells when the session is lost', async () => {
  const { value, spies } = ports();
  const view = render(
    <AvatarBackfillPanelV1 subjects={[subject(1)]} ready={false} ports={value} />,
  );
  expect((start() as HTMLButtonElement).disabled).toBe(true);
  spies.catalog.mockRejectedValue(new PhotoAdminClientErrorV1('unauthenticated'));
  view.rerender(<AvatarBackfillPanelV1 subjects={[subject(1)]} ready ports={value} />);
  await userEvent.setup().click(start());
  expect(
    await screen.findByText('Sessão ou permissão indisponível. Entre novamente e gere outra vez.'),
  ).toBeTruthy();
  expect(spies.client.save).not.toHaveBeenCalled();
});

it('appears in the student list only when the address asks for it and the operator may write', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const mock = accountsMockV1();
  const first = render(createElement(StudentAccountsV1, mock.props));
  await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' });
  expect(screen.queryByRole('button', { name: 'Gerar miniaturas que faltam' })).toBeNull();
  first.unmount();

  window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts&manutencao=miniaturas');
  const reader = render(createElement(StudentAccountsV1, { ...mock.props, canWrite: false }));
  await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' });
  expect(screen.queryByRole('button', { name: 'Gerar miniaturas que faltam' })).toBeNull();
  reader.unmount();

  render(createElement(StudentAccountsV1, mock.props));
  expect(await screen.findByRole('button', { name: 'Gerar miniaturas que faltam' })).toBeTruthy();
  expect(mock.writes).toHaveLength(0);
});
