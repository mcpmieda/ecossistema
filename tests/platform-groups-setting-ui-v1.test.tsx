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
  expect(within(table).getAllByRole('row')).toHaveLength(4);

  await user.type(screen.getByRole('textbox', { name: 'Adicionar pessoa' }), 'Dav');
  await user.click(
    await screen.findByRole('button', { name: 'Adicionar Davi Modelo' }, { timeout: 2000 }),
  );
  expect(await screen.findByText('Davi Modelo adicionado.')).toBeTruthy();
  expect(groupButton(/PROFESSORES.*4 membros/u)).toBeTruthy();
  expect(calls.at(-1)).toMatchObject({
    operation: 'add-member',
    email: 'davi.modelo@escola.example',
  });

  await user.click(screen.getByRole('button', { name: 'Remover Davi Modelo de PROFESSORES' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Davi Modelo sai de PROFESSORES.')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
  expect(await screen.findByText('Davi Modelo removido.')).toBeTruthy();
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
