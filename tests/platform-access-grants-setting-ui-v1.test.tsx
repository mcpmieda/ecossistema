// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccessGrantsSettingV1 } from '../src/platform/access-grants-setting-v1';

/** #1530 U8: Configurações › Acessos, with synthetic accounts only. */
const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
let puts: Array<Record<string, unknown>>;
let grants: Array<Record<string, unknown>>;

beforeEach(() => {
  puts = [];
  grants = [
    {
      id: '30000000-0000-4000-8000-000000000001',
      email: 'biblioteca@escola.example',
      areas: ['saude'],
      updatedAt: '2026-11-17T12:00:00.000Z',
      updatedBy: 'Administração sintética',
    },
  ];
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const change = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push(change);
        if (change.email === 'ninguem@escola.example')
          return Response.json({ state: 'account-not-found' }, { status: 404 });
        if ((change.areas as string[]).length === 0)
          grants = grants.filter((grant) => grant.email !== change.email);
      }
      return Response.json({ contractVersion: 1, grants, history: [] });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

it('removing an access asks first, and Cancelar keeps it', async () => {
  const user = userEvent.setup();
  render(<AccessGrantsSettingV1 />);
  const remove = await screen.findByRole('button', {
    name: 'Remover acesso de biblioteca@escola.example',
  });
  await user.click(remove);
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
  );
  expect(puts).toEqual([]);

  await user.click(remove);
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remover' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('list', { name: 'Acessos concedidos' })).toBeNull(),
  );
  // #1530 A3: a grant shown is removed by its person, not by the name shown.
  expect(puts).toEqual([
    {
      email: 'biblioteca@escola.example',
      areas: [],
      id: '30000000-0000-4000-8000-000000000001',
      expectedUpdatedAt: '2026-11-17T12:00:00.000Z',
    },
  ]);
});

it('editing fills the form, moves the focus to the e-mail and sends the version edited', async () => {
  const user = userEvent.setup();
  render(<AccessGrantsSettingV1 />);
  await user.click(
    await screen.findByRole('button', { name: 'Editar acesso de biblioteca@escola.example' }),
  );
  const email = screen.getByRole('textbox', { name: 'E-mail' });
  expect(document.activeElement).toBe(email);
  expect((email as HTMLInputElement).value).toBe('biblioteca@escola.example');
  await user.click(screen.getByRole('button', { name: 'Salvar acesso' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toEqual({
    id: '30000000-0000-4000-8000-000000000001',
    email: 'biblioteca@escola.example',
    areas: ['saude'],
    expectedUpdatedAt: '2026-11-17T12:00:00.000Z',
  });
});

it('a change made meanwhile is said once, the list is read again and the form starts over', async () => {
  const user = userEvent.setup();
  const fetcher = vi.mocked(fetch);
  render(<AccessGrantsSettingV1 />);
  await user.click(
    await screen.findByRole('button', { name: 'Editar acesso de biblioteca@escola.example' }),
  );
  fetcher.mockImplementationOnce(async () => Response.json({ state: 'changed' }, { status: 409 }));
  const before = fetcher.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Salvar acesso' }));
  expect(
    await screen.findByText('O acesso foi alterado por outra pessoa. Confira e salve de novo.'),
  ).toBeTruthy();
  await waitFor(() => expect(fetcher.mock.calls.length).toBe(before + 2));
  expect((screen.getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).value).toBe('');
});

it('says when no account has the e-mail typed', async () => {
  const user = userEvent.setup();
  render(<AccessGrantsSettingV1 />);
  await user.type(await screen.findByRole('textbox', { name: 'E-mail' }), 'ninguem@escola.example');
  await user.click(screen.getByRole('checkbox', { name: /Saúde/u }));
  await user.click(screen.getByRole('button', { name: 'Salvar acesso' }));
  expect(await screen.findByText('Nenhuma conta com esse e-mail.')).toBeTruthy();
});
