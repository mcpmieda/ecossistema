// @vitest-environment jsdom
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalAdminPage } from '../../../../src/features/student-portal-admin/student-portal-admin-page';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { accountJsonV1 } from '../accounts/fixtures-v1';
import { customizationsUiFixture827 } from './customizations-ui-fixture-827';

// The Painel loads every area, and the student drawer, as separate bundles, so the
// first mount in this file pays a cold dynamic import that outlasts the 1s default
// query window and the 5s default test budget. Widen both instead of weakening the
// queries: each one below still has to find the real accessible node.
configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(mock = customizationsUiFixture827(), area = 'policies') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => accountJsonV1(mock.catalog)),
  );
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=' + area);
  const view = render(<StudentPortalAdminPage fetcher={mock.fetcher} />);
  return { mock, view, user: userEvent.setup() };
}
async function grid() {
  // The grid element can precede its asynchronous row collection. Wait for the
  // actual accessible row actions as well, not merely the empty table shell.
  const tab = await screen.findByRole('tab', { name: 'Políticas personalizadas' });
  if (tab.getAttribute('aria-selected') !== 'true') await userEvent.click(tab);
  const card = document.querySelector('.pa-custom-settings');
  if (!(card instanceof HTMLElement)) throw new Error('Missing customization card');
  const table = await within(card).findByRole('grid', { name: 'Políticas personalizadas' });
  await within(table).findAllByRole('button', { name: /^Editar personalizações de /u });
  return table;
}
const student = 'SYNTHETIC ACCOUNT 001';
const difference = '2º trimestre: publicado para este aluno. Padrão da escola: não publicado.';

it.each(['Abrir', 'Editar'])(
  '%s opens the exact six-tab student drawer at Políticas, with the school comparison',
  async (verb) => {
    const { mock, user } = mount();
    const table = await grid();
    expect(within(table).getByText(difference)).toBeTruthy();
    await user.click(
      within(table).getByRole('button', { name: `${verb} personalizações de ${student}` }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Ficha do aluno' });
    expect(drawer.closest('[data-placement="right"]')).toBeTruthy();
    const tabs = await within(drawer).findByRole('tablist', { name: 'Dados do aluno' });
    // Includes the Fechamento preview tab (#1132 D12).
    expect(within(tabs).getAllByRole('tab')).toHaveLength(6);
    expect(within(tabs).getByRole('tab', { name: 'Políticas' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await user.click(await within(drawer).findByRole('tab', { name: 'Notas' }));
    expect(await within(drawer).findByText(difference)).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Bloquear acesso' })).toBeTruthy();
    expect(mock.commands).toHaveLength(0);
  },
);
it('uses the same comparison and reset inside the normally opened student drawer', async () => {
  const { mock, user } = mount(undefined, 'accounts');
  await user.click(await screen.findByRole('button', { name: `Abrir ficha de ${student}` }));
  const drawer = await screen.findByRole('dialog', { name: 'Ficha do aluno' });
  await user.click(await within(drawer).findByRole('tab', { name: 'Políticas' }));
  await user.click(await within(drawer).findByRole('tab', { name: 'Notas' }));
  await within(drawer).findByText(difference);
  await user.click(within(drawer).getByRole('button', { name: 'Voltar ao padrão' }));
  const review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  await user.click(within(review).getByRole('button', { name: 'Confirmar retorno ao padrão' }));
  await waitFor(() => expect(within(drawer).queryByText(difference)).toBeNull());
  expect(within(drawer).getByRole('tab', { name: 'Políticas' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(mock.commands).toHaveLength(1);
  expect(mock.commands[0]).toMatchObject({
    operation: 'publication-inherit',
    period: 'T2',
    expectedVersion: 7,
    expectedDecisionVersion: 6,
  });
});
it('cancels without a mutation and removes the final difference after the table reset is acknowledged', async () => {
  const { mock, user } = mount();
  const table = await grid();
  const trash = within(table).getByRole('button', { name: `Voltar ao padrão de ${student}` });
  await user.click(trash);
  let review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  await user.click(within(review).getByRole('button', { name: 'Cancelar' }));
  expect(mock.commands).toHaveLength(0);
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Voltar ao padrão' })).toBeNull(),
  );
  await user.click(trash);
  review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  expect(within(review).getByText(/Somente a opção selecionada/)).toBeTruthy();
  await user.click(within(review).getByRole('button', { name: 'Confirmar retorno ao padrão' }));
  await screen.findByText('Nenhuma personalização atual. Alunos e turmas seguem o padrão.');
  expect(mock.commands).toHaveLength(1);
  expect(mock.commands[0]?.operation).toBe('publication-inherit');
  expect(screen.queryByRole('grid', { name: 'Políticas personalizadas' })).toBeNull();
});
it('requires a specific choice when there are multiple differences, preserving the other setting', async () => {
  const mock = customizationsUiFixture827();
  mock.state.extraSetting = true;
  const { user } = mount(mock);
  await user.click(
    within(await grid()).getByRole('button', { name: `Voltar ao padrão de ${student}` }),
  );
  const review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  expect(
    within(review)
      .getByRole('button', { name: 'Confirmar retorno ao padrão' })
      .hasAttribute('disabled'),
  ).toBe(true);
  await user.click(within(review).getByRole('radio', { name: 'Publicação do 2º trimestre' }));
  await user.click(within(review).getByRole('button', { name: 'Confirmar retorno ao padrão' }));
  await waitFor(() =>
    expect(
      within(screen.getByRole('grid', { name: 'Políticas personalizadas' })).queryByText(
        difference,
      ),
    ).toBeNull(),
  );
  expect(mock.state.extraSetting).toBe(true);
  expect(await grid()).toBeTruthy();
  expect(mock.commands[0]?.operation).toBe('publication-inherit');
});
it('opens a class publication drawer, not a student identity, and resets only the class period', async () => {
  const mock = customizationsUiFixture827();
  mock.state.individual = false;
  mock.state.classExtra = true;
  const { user } = mount(mock);
  const table = await grid();
  expect(within(table).queryByText(student)).toBeNull();
  await user.click(
    within(table).getByRole('button', { name: 'Editar personalizações de SYNTHETIC CLASS A' }),
  );
  const drawer = await screen.findByRole('dialog', { name: 'Políticas da turma' });
  expect(screen.queryByRole('dialog', { name: 'Ficha do aluno' })).toBeNull();
  await user.click(await within(drawer).findByRole('tab', { name: 'Notas' }));
  await within(drawer).findByText(
    '3º trimestre: publicado para esta turma. Padrão da escola: não publicado.',
  );
  await user.click(within(drawer).getByRole('button', { name: 'Voltar ao padrão' }));
  const review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  await user.click(within(review).getByRole('button', { name: 'Confirmar retorno ao padrão' }));
  await waitFor(() => expect(mock.commands).toHaveLength(1));
  expect(mock.commands[0]).toMatchObject({
    operation: 'publication-inherit',
    scope: { kind: 'class', classId: 753001 },
    period: 'T3',
  });
});
it('rejects a stale confirmation instead of rebasing it, and disables resetting in read-only mode', async () => {
  const mock = customizationsUiFixture827();
  mock.state.reject = 'conflict';
  const { user } = mount(mock);
  await user.click(
    within(await grid()).getByRole('button', { name: `Voltar ao padrão de ${student}` }),
  );
  const review = await screen.findByRole('dialog', { name: 'Voltar ao padrão' });
  await user.click(within(review).getByRole('button', { name: 'Confirmar retorno ao padrão' }));
  await within(review).findByText(/A configuração mudou/);
  expect(within(review).queryByRole('button', { name: 'Confirmar retorno ao padrão' })).toBeNull();
  expect(mock.commands).toHaveLength(1);
  await user.click(within(review).getByRole('button', { name: 'Fechar e atualizar' }));
  mock.state.write = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(screen.getByText('Somente leitura')).toBeTruthy());
  expect(
    within(await grid())
      .getByRole('button', { name: `Voltar ao padrão de ${student}` })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(mock.commands).toHaveLength(1);
});
it('clears protected customization and drawer content after authorization loss', async () => {
  const { mock, user } = mount();
  await user.click(
    within(await grid()).getByRole('button', { name: `Abrir personalizações de ${student}` }),
  );
  const drawer = await screen.findByRole('dialog', { name: 'Ficha do aluno' });
  await user.click(await within(drawer).findByRole('tab', { name: 'Notas' }));
  await within(drawer).findByText(difference);
  mock.state.denied = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(screen.queryByText(student)).toBeNull());
  expect(screen.queryByRole('dialog', { name: 'Ficha do aluno' })).toBeNull();
  expect(mock.commands).toHaveLength(0);
});
