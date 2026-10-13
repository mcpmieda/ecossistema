import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentCredentialsV1 } from '../../../../src/features/student-portal-admin/credentials/student-credentials-v1';
import { QR_META_V1, qrJsonV1, qrMockV1, syntheticQrRendererV1 } from './fixtures-v1';
import { qrPrintIdV1 } from '../../qr-print/fixtures-v1';
import { controlledContinuousObserverV1 } from '../continuous-observer-v1';

beforeEach(() => {
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
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:synthetic-private-qr'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const first = () => screen.findByRole('checkbox', { name: 'Selecionar SYNTHETIC PRINT 001' });
const pdf = () => screen.getByRole('button', { name: 'Baixar PDF' });

describe('QR workspace #1101: explicit download, independent account selection and current QR', () => {
  it('separates QR selection from birth editing and birth queries', async () => {
    const mock = qrMockV1();
    render(createElement(StudentCredentialsV1, mock.props));
    await first();
    expect(screen.queryByRole('textbox', { name: /Ano de nascimento/ })).toBeNull();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '',
      'Aluno',
      'Turma',
      'Acesso',
    ]);
    expect(mock.queries.some((query) => query.operation === 'birth-years')).toBe(false);
    expect(mock.writes).toHaveLength(0);
  });
  it('does not select a pending account whose birth was not confirmed by the backend', async () => {
    const mock = qrMockV1();
    mock.accounts[0]!.firstAccess = {
      state: 'birth-unconfirmed',
      qrIssued: true,
      recoveryReady: false,
    };
    render(createElement(StudentCredentialsV1, mock.props));
    expect(((await first()) as HTMLInputElement).disabled).toBe(true);
    // With nothing ticked the PDF covers the list, which never includes the unconfirmed account.
    expect(screen.getByText('Lista inteira · 2')).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
  });
  it('generates and downloads in one explicit action, using accounts CAS rather than birth CAS', async () => {
    const mock = qrMockV1();
    render(createElement(StudentCredentialsV1, mock.props));
    fireEvent.click(await first());
    expect(screen.getByRole('radio', { name: 'Cartão completo · 9,35 × 5,9 cm' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Somente QR' })).toBeNull();
    fireEvent.click(pdf());
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({
      operation: 'qr-batch',
      expectedVersion: 755,
      accountIds: [qrPrintIdV1(1)],
      classId: 755001,
      mode: 'qr-name-class',
      confirmed: true,
    });
    expect(mock.queries.some((q) => q.operation === 'birth-years')).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preparar PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gerar QR individual' })).toBeNull();
    expect(document.body.textContent).not.toContain('/access#');
  });
  it('lets the operator download a ready PDF again without another QR request', async () => {
    const mock = qrMockV1();
    render(createElement(StudentCredentialsV1, mock.props));
    fireEvent.click(await first());
    fireEvent.click(pdf());
    const ready = await screen.findByRole('button', { name: 'Baixar PDF pronto' });
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    fireEvent.click(ready);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(2);
    expect(mock.writes).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Preparar outro PDF' }));
    expect(pdf()).toBeTruthy();
    expect(mock.writes).toHaveLength(1);
  });
  it.each([
    ['qr-only', 'Somente QR'],
    ['qr-name', 'QR + nome'],
  ] as const)(
    'uses the selected %s mode without sending the optional instruction to the server',
    async (mode, label) => {
      const mock = qrMockV1();
      render(createElement(StudentCredentialsV1, mock.props));
      fireEvent.click(await first());
      fireEvent.click(screen.getByRole('radio', { name: 'QR compacto' }));
      fireEvent.click(screen.getByRole('radio', { name: label }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Adicionar instrução ao cartão' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Instrução abaixo do QR' }), {
        target: { value: 'INSTRUCAO SINTETICA LOCAL' },
      });
      fireEvent.click(pdf());
      await waitFor(() => expect(mock.writes).toHaveLength(1));
      expect(mock.writes[0]).toMatchObject({ mode });
      expect(mock.bodies[0]).not.toContain('INSTRUCAO SINTETICA LOCAL');
      await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    },
  );
  it('selects and deselects through the header checkbox without issuing anything', async () => {
    const mock = qrMockV1();
    render(createElement(StudentCredentialsV1, mock.props));
    await first();
    expect(screen.queryByRole('button', { name: 'Selecionar lista' })).toBeNull();
    const all = screen.getByRole('checkbox', { name: 'Selecionar alunos disponíveis' });
    fireEvent.click(all);
    expect(screen.getByText('3 selecionados')).toBeTruthy();
    fireEvent.click(all);
    expect(screen.getByText('Lista inteira · 3')).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
  });
  it('loads remaining pages and prepares every QR in chunks of at most four', async () => {
    const observer = controlledContinuousObserverV1(),
      mock = qrMockV1({ count: 105 });
    render(createElement(StudentCredentialsV1, mock.props));
    await first();
    // A list still loading is not whole: it keeps asking for an explicit selection.
    expect(screen.getByText('0 selecionados')).toBeTruthy();
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    await act(async () => observer.intersect());
    await screen.findByText('SYNTHETIC PRINT 105');
    expect(await screen.findByText('Lista inteira · 105')).toBeTruthy();
    expect(pdf().hasAttribute('disabled')).toBe(false);
    fireEvent.click(pdf());
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(mock.writes).toHaveLength(27);
    expect(
      mock.writes.every((entry) => entry.operation === 'qr-batch' && entry.accountIds.length <= 4),
    ).toBe(true);
    expect(
      mock.writes.flatMap((entry) => (entry.operation === 'qr-batch' ? entry.accountIds : [])),
    ).toHaveLength(105);
  }, 30_000);
  it('retries rendering after a confirmed command without issuing another QR command', async () => {
    let calls = 0;
    const renderer = vi.fn(async (...args: Parameters<typeof syntheticQrRendererV1>) => {
      if (++calls === 1) throw new Error('synthetic render failure');
      return syntheticQrRendererV1(...args);
    });
    const mock = qrMockV1();
    render(createElement(StudentCredentialsV1, { ...mock.props, renderArtifact: renderer }));
    fireEvent.click(await first());
    fireEvent.click(pdf());
    const retry = await screen.findByRole('button', { name: 'Repetir mesma solicitação' });
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(mock.writes).toHaveLength(1);
    expect(renderer).toHaveBeenCalledTimes(2);
  });
  it('keeps the exact request when a response is lost, never treating the failure as success', async () => {
    let writes = 0;
    const mock = qrMockV1({
      write: () =>
        ++writes <= 2 ? Promise.reject(new Error('synthetic lost response')) : undefined,
    });
    render(createElement(StudentCredentialsV1, mock.props));
    fireEvent.click(await first());
    fireEvent.click(pdf());
    const retry = await screen.findByRole('button', { name: 'Repetir mesma solicitação' });
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(new Set(mock.bodies).size).toBe(1);
  });
  it.each(['forbidden', 'unauthenticated'] as const)(
    'reports %s without a download or silent repeat',
    async (state) => {
      const lost = vi.fn(),
        mock = qrMockV1({
          write: () =>
            Promise.resolve(qrJsonV1({ ...QR_META_V1, state }, state === 'forbidden' ? 403 : 401)),
        });
      render(createElement(StudentCredentialsV1, { ...mock.props, onAuthorizationLost: lost }));
      fireEvent.click(await first());
      fireEvent.click(pdf());
      await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
      expect(mock.writes).toHaveLength(1);
    },
  );
  it('automatically reprints only the current QR in the individual view and clears on unmount', async () => {
    const mock = qrMockV1(),
      view = render(
        createElement(StudentCredentialsV1, {
          ...mock.props,
          scope: { kind: 'account', academicYear: 2026, accountId: qrPrintIdV1(1) },
        }),
      );
    const image = await screen.findByRole('img', { name: 'QR atual de acesso' });
    // Admin CSP only allows data: images; a blob: preview would render broken.
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/u);
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({
      operation: 'qr-reprint',
      expectedVersion: 7,
      accountId: qrPrintIdV1(1),
    });
    expect(screen.queryByRole('button', { name: 'Baixar PDF' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Imprimir QR' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar QR' }));
    await screen.findByText(/Cópia indisponível/);
    view.unmount();
    expect(screen.queryByRole('img', { name: 'QR atual de acesso' })).toBeNull();
  });
  it('clears the individual QR when photo access is forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const lost = vi.fn();
    const mock = qrMockV1();
    render(
      createElement(StudentCredentialsV1, {
        ...mock.props,
        scope: { kind: 'account', academicYear: 2026, accountId: qrPrintIdV1(1) },
        onAuthorizationLost: lost,
      }),
    );
    await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    expect(lost.mock.calls[0]?.[0]).toMatchObject({ state: 'forbidden' });
    expect(screen.queryByRole('img', { name: 'QR atual de acesso' })).toBeNull();
  });
  it('does not issue or regenerate a missing QR just by opening the individual view', async () => {
    const mock = qrMockV1();
    mock.accounts[0]!.firstAccess = { state: 'qr-missing', qrIssued: false, recoveryReady: true };
    render(
      createElement(StudentCredentialsV1, {
        ...mock.props,
        scope: { kind: 'account', academicYear: 2026, accountId: qrPrintIdV1(1) },
      }),
    );
    await screen.findByText(/Nenhum QR emitido/);
    expect(mock.writes).toHaveLength(0);
  });
  it('removes private images on an identity or permission change', async () => {
    const mock = qrMockV1(),
      props = {
        ...mock.props,
        scope: { kind: 'account' as const, academicYear: 2026 as const, accountId: qrPrintIdV1(1) },
      };
    const view = render(createElement(StudentCredentialsV1, props));
    await screen.findByRole('img', { name: 'QR atual de acesso' });
    view.rerender(
      createElement(StudentCredentialsV1, {
        ...props,
        identityKey: 'different-operator',
        canWrite: false,
      }),
    );
    expect(screen.queryByRole('img', { name: 'QR atual de acesso' })).toBeNull();
    await screen.findByText('Somente operadores autorizados podem consultar o QR.');
    expect(mock.writes).toHaveLength(1);
  });
  it('mounting a bulk workspace under StrictMode never emits credentials', async () => {
    const mock = qrMockV1();
    render(createElement(StrictMode, null, createElement(StudentCredentialsV1, mock.props)));
    await first();
    expect(mock.writes).toHaveLength(0);
  });
});
