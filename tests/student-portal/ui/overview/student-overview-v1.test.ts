import { createElement, StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentOverviewV1 } from '../../../../src/features/student-portal-admin/overview/student-overview-v1';
import { operationsMockV1, opJsonV1, OP_META_V1 } from './fixtures-v1';
import { setupOperationsDomV1 } from './dom-v1';
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('actual operational summary and health', () => {
  it('honors rate limiting instead of reporting a successful partial read', async () => {
    const mock = operationsMockV1({
      query: (q) =>
        q.operation === 'overview'
          ? Promise.resolve(
              opJsonV1({ ...OP_META_V1, state: 'rate-limited' }, 429, { 'Retry-After': '30' }),
            )
          : undefined,
    });
    render(createElement(StudentOverviewV1, mock.props));
    await screen.findByText('Limite temporário. Aguarde para consultar novamente.');
    expect(
      (screen.getByRole('button', { name: 'Tentar novamente' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.querySelector('.pa-dashboard-stats, dl')).toBeNull();
    expect(mock.queries.some((q) => q.operation === 'health')).toBe(false);
  });
  it.each([
    ['normal', 'Operando normalmente'],
    ['attention', 'Atenção'],
    ['intervention', 'Intervenção necessária'],
  ] as const)('translates %s without decorative metrics', async (status, label) => {
    const mock = operationsMockV1({ health: status });
    render(createElement(StrictMode, null, createElement(StudentOverviewV1, mock.props)));
    await screen.findByText(label);
    expect(screen.getByText('Sessões ativas')).toBeTruthy();
    expect(screen.queryByText(/As categorias se sobrepõem/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sobre Sessões ativas' })).toBeTruthy();
    expect(document.querySelectorAll('.pa-stat')).toHaveLength(6);
    // Cards cannot be valid dt/dd groups; the counts are a plain list of label and value.
    expect(document.querySelectorAll('.pa-dashboard-stats > [role="listitem"]')).toHaveLength(6);
    expect(document.querySelector('.pa-dashboard-stats dt, .pa-dashboard-stats dd')).toBeNull();
    expect(document.querySelector('svg[role="img"],canvas')).toBeNull();
    expect(mock.queries.some((q) => q.operation === 'health')).toBe(false);
  });
  it('keeps actual health observable when counts fail and never substitutes zero totals', async () => {
    const mock = operationsMockV1({
      query: (q) =>
        q.operation === 'overview'
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unavailable' }, 503))
          : undefined,
    });
    render(createElement(StudentOverviewV1, mock.props));
    await screen.findByText('Operando normalmente');
    expect(screen.getByText(/Os totais não foram substituídos por zero/)).toBeTruthy();
    expect(document.querySelector('.pa-dashboard-stats, dl')).toBeNull();
    expect(mock.queries.filter((q) => q.operation === 'health')).toHaveLength(1);
  });
  it('reviews and starts the complete school population without issuing credentials or publications', async () => {
    const user = userEvent.setup(),
      mock = operationsMockV1();
    render(
      createElement(StudentOverviewV1, {
        ...mock.props,
      }),
    );
    await screen.findByText('Cadastro automático desativado');
    expect(screen.getByText('Alunos com vínculo').nextElementSibling?.textContent).toBe('353');
    await user.click(screen.getByRole('button', { name: 'Ativar cadastro automático' }));
    const review = await screen.findByRole('alertdialog');
    expect(review.textContent).toContain('381 perfis');
    expect(review.textContent).toContain('Nenhum QR será emitido');
    await user.click(screen.getByRole('button', { name: 'Ativar e sincronizar' }));
    await screen.findByText('Cadastro automático ativo');
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({
      operation: 'population-start',
      academicYear: 2026,
      clearOverrides: true,
      confirmed: true,
    });
  });
  it('asks for a new review after a refused population start instead of sending another command', async () => {
    const user = userEvent.setup();
    let refused = false;
    const mock = operationsMockV1({
      write: (command) => {
        if (command.operation !== 'population-start' || refused) return undefined;
        refused = true;
        return Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'conflict' }, 409));
      },
    });
    render(
      createElement(StudentOverviewV1, {
        ...mock.props,
      }),
    );
    await screen.findByText('Cadastro automático desativado');
    await user.click(screen.getByRole('button', { name: 'Ativar cadastro automático' }));
    await user.click(await screen.findByRole('button', { name: 'Ativar e sincronizar' }));
    await user.click(await screen.findByRole('button', { name: 'Consultar novamente' }));
    expect(screen.queryByRole('button', { name: 'Tentar sincronização novamente' })).toBeNull();
    expect(mock.writes).toHaveLength(1);
    await user.click(await screen.findByRole('button', { name: 'Ativar cadastro automático' }));
    expect((await screen.findByRole('alertdialog')).textContent).toContain('381 perfis');
    await user.click(screen.getByRole('button', { name: 'Ativar e sincronizar' }));
    await screen.findByText('Cadastro automático ativo');
    expect(mock.writes).toHaveLength(2);
    expect(mock.writes[0]!.idempotencyKey).not.toBe(mock.writes[1]!.idempotencyKey);
  });
  it('does not invent normal health on failure and clears counts if either request loses authorization', async () => {
    const mock = operationsMockV1({
      query: (q) =>
        q.operation === 'health'
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unauthenticated' }, 401))
          : q.operation === 'overview'
            ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unavailable' }, 503))
            : undefined,
    });
    render(createElement(StudentOverviewV1, mock.props));
    await screen.findByText('Sessão administrativa expirada. Entre novamente.');
    expect(screen.queryByText('Operando normalmente')).toBeNull();
    expect(document.querySelector('.pa-dashboard-stats, dl')).toBeNull();
    expect(document.body.textContent).not.toContain('SYNTHETIC OP STUDENT');
  });
  it('does not request fallback health when the summary denies authorization', async () => {
    const mock = operationsMockV1({
      query: (q) =>
        q.operation === 'overview'
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'forbidden' }, 403))
          : undefined,
    });
    render(createElement(StudentOverviewV1, mock.props));
    await screen.findByText('Sem permissão para esta consulta.');
    expect(mock.queries.some((q) => q.operation === 'health')).toBe(false);
    expect(screen.queryByText('Operando normalmente')).toBeNull();
  });
});
