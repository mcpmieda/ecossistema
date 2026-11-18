// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupsSettingV1 } from '../src/platform/groups-setting-v1';

const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
let calls: Array<Record<string, unknown>>;

beforeEach(async () => {
  vi.resetModules();
  const { previewGroupsV1 } = await import('../src/adm-preview/groups-preview-v1');
  calls = [];
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      calls.push(JSON.parse(body) as Record<string, unknown>);
      const answer = previewGroupsV1(body);
      return Response.json(answer.value, { status: answer.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

const groupButton = (name: RegExp) =>
  within(screen.getByRole('list', { name: 'Grupos' })).getByRole('button', { name });

it('#1513 Grupos: opens a group, adds by search, removes after confirming, and keeps the count', async () => {
  const user = userEvent.setup();
  render(<GroupsSettingV1 />);
  await user.click(await screen.findByRole('button', { name: /PROFESSORES.*3 membros/u }));
  const table = await screen.findByRole('grid', { name: 'Membros de PROFESSORES' });
  // #1530 U2: the grid exists before React Aria fills its rows.
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4), { timeout: 5000 });
  // #1530 P1: the flow keeps these by their job title.
  expect(within(table).getAllByText('Por cargo')).toHaveLength(3);

  await user.type(screen.getByRole('textbox', { name: 'Adicionar pessoa' }), 'Dav');
  await user.click(
    await screen.findByRole('button', { name: 'Adicionar Davi Modelo' }, { timeout: 2000 }),
  );
  expect(await screen.findByText('Davi Modelo entrou no grupo.')).toBeTruthy();
  expect(groupButton(/PROFESSORES.*4 membros/u)).toBeTruthy();
  expect(calls.at(-1)).toMatchObject({
    operation: 'add-member',
    email: 'davi.modelo@escola.example',
  });

  await user.click(screen.getByRole('button', { name: 'Remover Davi Modelo de PROFESSORES' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Davi Modelo sai de PROFESSORES.')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
  expect(await screen.findByText('Davi Modelo saiu do grupo.')).toBeTruthy();
  expect(groupButton(/PROFESSORES.*3 membros/u)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Histórico' }));
  const history = await screen.findByRole('list', { name: 'Histórico do grupo' });
  expect(
    within(history)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    expect.stringContaining('Removeu davi.modelo@escola.example'),
    expect.stringContaining('Adicionou davi.modelo@escola.example'),
  ]);
});

it('#1530 P1: removing someone kept by a job-title rule warns that the flow adds them back', async () => {
  const user = userEvent.setup();
  render(<GroupsSettingV1 />);
  await user.click(await screen.findByRole('button', { name: /PROFESSORES/u }));
  await user.click(
    await screen.findByRole('button', { name: 'Remover Bruno Fictício de PROFESSORES' }),
  );
  expect(
    within(await screen.findByRole('alertdialog')).getByText(
      /a automação vai adicioná-la de novo/u,
    ),
  ).toBeTruthy();
});

it('#1530 U1: the result of a deletion is shown once and the address the app keeps loses it', async () => {
  window.history.replaceState(null, '', '/#/configuracoes?grupos=excluido');
  const changed = vi.fn();
  window.addEventListener('hashchange', changed);
  render(<GroupsSettingV1 />);
  expect(await screen.findByText('Grupo excluído.')).toBeTruthy();
  expect(window.location.hash).toBe('#/configuracoes');
  await waitFor(() => expect(changed).toHaveBeenCalled());
  window.removeEventListener('hashchange', changed);
  expect(screen.getAllByText('Grupo excluído.')).toHaveLength(1);
});

it('#1513 Grupos: says why a change was refused, and creates a group that opens selected', async () => {
  const user = userEvent.setup();
  render(<GroupsSettingV1 />);
  await user.click(await screen.findByRole('button', { name: /GRUPO DA SECRETARIA/u }));
  await user.click(
    await screen.findByRole('button', { name: 'Remover Ana Exemplo de GRUPO DA SECRETARIA' }),
  );
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remover' }),
  );
  expect(await screen.findByText('Você não pode se remover do grupo da Secretaria.')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Novo grupo' }));
  const name = await screen.findByRole('textbox', { name: 'Nome' });
  await user.type(name, 'PROFESSORES');
  await user.click(screen.getByRole('button', { name: 'Criar grupo' }));
  expect(await screen.findByText('Já existe um grupo com esse nome.')).toBeTruthy();
  await user.clear(name);
  await user.type(name, 'Biblioteca');
  await user.click(screen.getByRole('button', { name: 'Criar grupo' }));
  await waitFor(() =>
    expect(groupButton(/Biblioteca.*Criado no Centro/u).getAttribute('aria-pressed')).toBe('true'),
  );
  expect(await screen.findByRole('grid', { name: 'Membros de Biblioteca' })).toBeTruthy();
});

it('#1513 Grupos: deleting asks for the exact name, and the way back says how it ended', async () => {
  window.history.replaceState(null, '', '/#/configuracoes');
  const user = userEvent.setup();
  render(<GroupsSettingV1 />);
  await user.click(await screen.findByRole('button', { name: 'Novo grupo' }));
  await user.type(await screen.findByRole('textbox', { name: 'Nome' }), 'Biblioteca');
  await user.click(screen.getByRole('button', { name: 'Criar grupo' }));
  await screen.findByRole('grid', { name: 'Membros de Biblioteca' });
  // A role group has no delete button.
  await user.click(groupButton(/PROFESSORES/u));
  await screen.findByRole('grid', { name: 'Membros de PROFESSORES' });
  expect(screen.queryByRole('button', { name: 'Excluir grupo' })).toBeNull();
  await user.click(groupButton(/Biblioteca/u));

  await user.click(await screen.findByRole('button', { name: 'Excluir grupo' }));
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: 'Excluir' });
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Digite o nome do grupo' }),
    'biblioteca',
  );
  expect(confirm.hasAttribute('disabled') || confirm.getAttribute('data-disabled') === 'true').toBe(
    true,
  );
  const input = within(dialog).getByRole('textbox', { name: 'Digite o nome do grupo' });
  await user.clear(input);
  await user.type(input, 'Biblioteca');
  await user.click(confirm);

  expect(await screen.findByText('Grupo excluído.')).toBeTruthy();
  await waitFor(() =>
    expect(
      within(screen.getByRole('list', { name: 'Grupos' })).queryByRole('button', {
        name: /Biblioteca/u,
      }),
    ).toBeNull(),
  );
  expect(window.location.hash).toBe('#/configuracoes');
  expect(
    calls.some((call) => call.operation === 'delete-start' && call.confirmName === 'Biblioteca'),
  ).toBe(true);
});
