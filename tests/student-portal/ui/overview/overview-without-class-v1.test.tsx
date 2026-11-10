import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewClassesV1 } from '../../../../src/features/student-portal-admin/overview/overview-classes-v1';
import { StudentAccountsV1 } from '../../../../src/features/student-portal-admin/accounts/student-accounts-v1';
import { setupOperationsDomV1 } from './dom-v1';
import { accountsMockV1 } from '../accounts/fixtures-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const counts = (accounts: number) => ({
  accounts,
  active: accounts,
  pendingActivation: 0,
  resetRequired: 0,
  blocked: 0,
  unresolved: 0,
  unlinked: 0,
  accessEnabled: 0,
  accessPermitted: 0,
  validSessions: 0,
});

it('a linha Sem turma da Visão geral abre a lista de Alunos (clique, Enter e Espaço)', async () => {
  const open = vi.fn();
  render(
    <OverviewClassesV1
      classes={[
        { classId: 1, counts: counts(3) },
        { classId: null, counts: counts(1) },
      ]}
      labels={[{ id: 1, label: 'SYNTHETIC CLASS A' }]}
      onOpenWithoutClass={open}
    />,
  );
  const user = userEvent.setup();
  const row = screen.getByRole('row', { name: 'Sem turma, ver na lista de Alunos' });
  expect(row.classList.contains('cursor-pointer')).toBe(true);
  await user.click(row);
  expect(open).toHaveBeenCalledTimes(1);
  row.focus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledTimes(2);
  await user.keyboard(' ');
  expect(open).toHaveBeenCalledTimes(3);
  // The classes stay as they were.
  await user.click(screen.getByText('SYNTHETIC CLASS A'));
  expect(open).toHaveBeenCalledTimes(3);
  expect(screen.getByText('SYNTHETIC CLASS A').closest('tr')!.classList).not.toContain(
    'cursor-pointer',
  );
});

it('a lista de Alunos aberta com semturma=1 mostra só as contas sem turma', async () => {
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts&semturma=1');
  const mock = accountsMockV1({ count: 3 });
  mock.accounts[1] = { ...mock.accounts[1]!, classId: null, classLabel: '' };
  render(<StudentAccountsV1 {...mock.props} />);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 002' });
  expect(screen.queryByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 003' })).toBeNull();
  const tag = screen.getByRole('row', { name: 'Sem turma' });
  expect(tag.getAttribute('aria-selected')).toBe('true');
  await user.click(tag);
  await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' });
  await waitFor(() =>
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('semturma')).toBeNull(),
  );
  expect(mock.writes).toHaveLength(0);
});
