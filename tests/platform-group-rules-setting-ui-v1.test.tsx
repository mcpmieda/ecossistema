// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupRulesSettingV1 } from '../src/platform/group-rules-setting-v1';

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

it('#1513 Regras por cargo: lists the rules and who to review, creates a rule from a title without one', async () => {
  const user = userEvent.setup();
  render(<GroupRulesSettingV1 />);
  const table = await screen.findByRole('grid', { name: 'Regras por cargo' }, { timeout: 5000 });
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  const review = screen.getByRole('region', { name: 'Pessoas para revisar' });
  expect(within(review).getByText('Sem cargo')).toBeTruthy();
  expect(within(review).getByText('Sem regra')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Criar regra para Bibliotecária' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nova regra' }, { timeout: 5000 });
  expect((within(dialog).getByRole('textbox', { name: 'Cargo' }) as HTMLInputElement).value).toBe(
    'Bibliotecária',
  );
  const save = within(dialog).getByRole('button', { name: 'Salvar regra' });
  expect(save.hasAttribute('disabled') || save.getAttribute('data-disabled') === 'true').toBe(true);
  await user.click(within(dialog).getByRole('button', { name: /Grupo/u }));
  await user.click(
    await screen.findByRole('option', { name: 'EQUIPE DE APOIO' }, { timeout: 5000 }),
  );
  await user.click(save);

  expect(
    await screen.findByText('Regra "Bibliotecária" salva.', undefined, { timeout: 5000 }),
  ).toBeTruthy();
  expect(calls.find((call) => call.operation === 'save-rule')).toMatchObject({
    cargo: 'Bibliotecária',
    action: 'ADICIONAR',
    groupId: '10000000-0000-4000-8000-000000000004',
    active: true,
  });
  await waitFor(
    () =>
      expect(
        within(screen.getByRole('grid', { name: 'Regras por cargo' })).getAllByRole('row'),
      ).toHaveLength(7),
    { timeout: 5000 },
  );
});

it('#1513 Regras por cargo: refuses a second active rule and removes one after confirming', async () => {
  const user = userEvent.setup();
  render(<GroupRulesSettingV1 />);
  await screen.findByRole('grid', { name: 'Regras por cargo' }, { timeout: 5000 });
  await user.click(screen.getByRole('button', { name: 'Nova regra' }));
  const dialog = await screen.findByRole('dialog', { name: 'Nova regra' }, { timeout: 5000 });
  await user.type(within(dialog).getByRole('textbox', { name: 'Cargo' }), 'Professor');
  await user.click(within(dialog).getByRole('button', { name: /Ação/u }));
  await user.click(await screen.findByRole('option', { name: 'Ignorar' }, { timeout: 5000 }));
  await user.click(within(dialog).getByRole('button', { name: 'Salvar regra' }));
  expect(
    await within(dialog).findByText('Já existe uma regra ativa para esse cargo.', undefined, {
      timeout: 5000,
    }),
  ).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

  await user.click(screen.getByRole('button', { name: 'Remover regra administrador global' }));
  await user.click(
    within(await screen.findByRole('alertdialog', undefined, { timeout: 5000 })).getByRole(
      'button',
      { name: 'Remover' },
    ),
  );
  expect(
    await screen.findByText('Regra "administrador global" removida.', undefined, { timeout: 5000 }),
  ).toBeTruthy();
  await waitFor(
    () =>
      expect(
        within(screen.getByRole('grid', { name: 'Regras por cargo' })).getAllByRole('row'),
      ).toHaveLength(5),
    { timeout: 5000 },
  );
});
