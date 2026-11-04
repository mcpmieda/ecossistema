import { AccountOpenContextV1 } from '../../../../src/features/student-portal-admin/shared/account-open-v1';
import { enterDateV1 } from '../settings/date-input-v1';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentAuditV1 } from '../../../../src/features/student-portal-admin/audit/student-audit-v1';
import { operationsMockV1, opJsonV1, OP_META_V1, OP_CLASS_V1 } from '../overview/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { controlledContinuousObserverV1 } from '../continuous-observer-v1';
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('audit filters and restricted detail interface', () => {
  it('keeps raw IP out of list; detail needs write capability and disappears when it changes', async () => {
    const mock = operationsMockV1();
    const view = render(createElement(StudentAuditV1, mock.props));
    await screen.findByRole('grid');
    expect(document.body.textContent).not.toContain('192.0.2.*');
    expect(document.body.textContent).not.toContain('192.0.2.42');
    fireEvent.click(screen.getAllByRole('button', { name: 'Detalhes' })[0]!);
    await screen.findByText('192.0.2.42');
    view.rerender(createElement(StudentAuditV1, { ...mock.props, canWrite: false }));
    await screen.findByRole('grid');
    expect(document.body.textContent).not.toContain('192.0.2.42');
    expect(
      screen
        .getAllByRole('button', { name: 'Detalhes' })
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('applies São Paulo interval only after validation and preserves event/result filters in cursor pages', async () => {
    const observer = controlledContinuousObserverV1();
    const user = userEvent.setup();
    // Keep keyboard/date validation independent of table volume. Small responses are valid
    // under the unchanged 100-row request limit; the full 105-row boundary is tested below.
    const source = operationsMockV1({ count: 3 });
    const mock = operationsMockV1({
      query: (query) => query.contractVersion === 1 && query.operation === 'audit'
        ? source.client.query({ ...query, page: { ...query.page, limit: 2 } }).then(opJsonV1)
        : undefined,
    });
    render(createElement(StudentAuditV1, { ...mock.props, scope: OP_CLASS_V1 }));
    await screen.findByRole('grid');
    await enterDateV1(user, 'Desde', '2026-09-14T10:00:00');
    await enterDateV1(user, 'Até', '2026-09-13T10:00:00');
    const before = mock.queries.filter((q) => q.operation === 'audit').length;
    expect(screen.queryByRole('button', { name: 'Aplicar filtros' })).toBeNull();
    expect(await screen.findByText(/Confira a ordem das datas/)).toBeTruthy();
    expect(mock.queries.filter((q) => q.operation === 'audit')).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await user.click(screen.getByRole('button', { name: 'Todos os eventos Evento' }));
    await user.click(await screen.findByRole('option', { name: 'Sessão encerrada' }));
    await user.click(screen.getByRole('button', { name: 'Todos os resultados Resultado' }));
    await user.click(await screen.findByRole('option', { name: 'Concluído' }));
    await enterDateV1(user, 'Desde', '2026-01-01T00:00:00');
    expect(screen.queryByRole('button', { name: 'Aplicar filtros' })).toBeNull();
    await waitFor(() =>
      expect(mock.queries.at(-1)).toMatchObject({
        operation: 'audit',
        scope: OP_CLASS_V1,
        from: '2026-01-01T03:00:00Z',
        event: 'session-revoked',
        result: 'success',
      }),
    );
    await screen.findByRole('grid');
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    expect(screen.getAllByRole('button', { name: 'Detalhes' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Próxima página' })).toBeNull();
    await act(async () => observer.intersect());
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Detalhes' })).toHaveLength(3),
    );
    expect(mock.queries.at(-1)).toMatchObject({
      from: '2026-01-01T03:00:00Z',
      event: 'session-revoked',
      result: 'success',
      page: { limit: 100 },
    });
    expect(mock.queries.at(-1)!.page.cursor).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
  }, 20_000);
  it('"Até" includes the whole chosen minute', async () => {
    const user = userEvent.setup();
    const mock = operationsMockV1({ count: 3 });
    render(createElement(StudentAuditV1, { ...mock.props, scope: OP_CLASS_V1 }));
    await screen.findByRole('grid');
    await enterDateV1(user, 'Até', '2026-11-03T14:30:00');
    await waitFor(() =>
      expect(mock.queries.at(-1)).toMatchObject({
        operation: 'audit',
        until: '2026-11-03T17:30:59.999Z',
      }),
    );
    expect(mock.writes).toHaveLength(0);
  }, 20_000);
  it('renders 100 audit events first and appends the final five only on demand', async () => {
    const observer = controlledContinuousObserverV1();
    const mock = operationsMockV1({ count: 105 });
    render(createElement(StudentAuditV1, { ...mock.props, scope: OP_CLASS_V1 }));
    await screen.findByRole('grid');
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    const first = screen.getAllByText('Detalhes')[0]!;
    expect(screen.getAllByText('Detalhes')).toHaveLength(100);
    expect(mock.queries.filter((query) => query.operation === 'audit')).toHaveLength(1);
    await act(async () => observer.intersect());
    await waitFor(() => expect(screen.getAllByText('Detalhes')).toHaveLength(105));
    expect(screen.getAllByText('Detalhes')[0]).toBe(first);
    const queries = mock.queries.filter((query) => query.operation === 'audit');
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({ scope: OP_CLASS_V1, page: { limit: 100 } });
    expect(queries[1]!.page.cursor).toBeTruthy();
    expect(screen.queryByText('Próxima página')).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it('shows empty results without fake events and clears all detail on authorization loss', async () => {
    let denied = false;
    const mock = operationsMockV1({
      query: (q) =>
        denied && q.operation === 'audit-detail'
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'forbidden' }, 403))
          : undefined,
    });
    render(createElement(StudentAuditV1, mock.props));
    await screen.findByRole('grid');
    denied = true;
    fireEvent.click(screen.getAllByRole('button', { name: 'Detalhes' })[0]!);
    await screen.findByText('Sem permissão para esta consulta.');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('192.0.2.');
  });
});

it('shows historical entities and opens the authorized account by its id, never by matching its name', async () => {
  const source = operationsMockV1({ count: 1 });
  const open = vi.fn();
  const mock = operationsMockV1({ query: query => query.contractVersion === 1 && query.operation === 'audit'
    ? source.client.query(query).then(response => {
      if (response.state !== 'audit') throw new Error('synthetic-audit-response');
      return opJsonV1({ ...response, items: response.items.map(item => ({ ...item, entities: { actorName: 'SYNTHETIC OPERATOR', subjectName: 'SYNTHETIC HISTORICAL NAME', classId: 756001, classLabel: 'SYNTHETIC HISTORICAL CLASS' } })) });
    }) : undefined });
  render(createElement(AccountOpenContextV1.Provider, { value: open }, createElement(StudentAuditV1, mock.props)));
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC HISTORICAL NAME' }));
  // By the student, not by the list's class: an event may predate a class change (29/09/2026).
  expect(open).toHaveBeenCalledWith('75600000-0000-4000-8000-000000000001', { kind: 'school', academicYear: 2026 });
  expect(screen.getByText('SYNTHETIC OPERATOR')).toBeTruthy();
  expect(screen.getByText('SYNTHETIC HISTORICAL CLASS')).toBeTruthy();
  expect(mock.queries.find(query => query.operation === 'audit')).toMatchObject({ includeEntities: true });
});
