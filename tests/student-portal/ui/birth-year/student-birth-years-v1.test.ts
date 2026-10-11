import { createElement, StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentBirthYearsV1 } from '../../../../src/features/student-portal-admin/birth-year/student-birth-years-v1';
import { BIRTH_META_V1, birthJsonV1, birthMockV1 } from './fixtures-v1';

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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nascimento administrativo somente leitura', () => {
  it('exibe o valor anterior preservado sem editor, apagar, autosave ou comando', async () => {
    const mock = birthMockV1();
    render(createElement(StudentBirthYearsV1, mock.props));
    await screen.findByText('SYNTHETIC BIRTH 001');
    expect(screen.getByText('2000')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Salvar|Limpar|Apagar|Confirmar ano/u }),
    ).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it('atualiza a leitura sem transformar valor legado em confirmação manual', async () => {
    const mock = birthMockV1();
    render(createElement(StudentBirthYearsV1, mock.props));
    await screen.findByText('2000');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(mock.queries.length).toBeGreaterThanOrEqual(4));
    expect(mock.writes).toHaveLength(0);
  });
  it.each(['forbidden', 'unauthenticated'] as const)(
    'remove os dados protegidos quando a leitura retorna %s',
    async (state) => {
      const lost = vi.fn();
      const mock = birthMockV1({
        query: async () =>
          birthJsonV1({ ...BIRTH_META_V1, state }, state === 'forbidden' ? 403 : 401),
      });
      render(createElement(StudentBirthYearsV1, { ...mock.props, onAuthorizationLost: lost }));
      await waitFor(() => expect(lost).toHaveBeenCalled());
      expect(screen.queryByText('SYNTHETIC BIRTH 001')).toBeNull();
      expect(mock.writes).toHaveLength(0);
    },
  );
  it('nova identidade limpa a leitura anterior e continua sem capacidade de editar', async () => {
    const mock = birthMockV1();
    const view = render(createElement(StudentBirthYearsV1, mock.props));
    await screen.findByText('2000');
    view.rerender(
      createElement(StudentBirthYearsV1, {
        ...mock.props,
        identityKey: 'new-synthetic-operator',
        canWrite: false,
      }),
    );
    expect(screen.queryByText('2000')).toBeNull();
    await screen.findByText('2000');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it('StrictMode não escreve nem confirma nascimento ao montar', async () => {
    const mock = birthMockV1();
    render(createElement(StrictMode, null, createElement(StudentBirthYearsV1, mock.props)));
    await screen.findByText('2000');
    expect(mock.writes).toHaveLength(0);
  });
});
