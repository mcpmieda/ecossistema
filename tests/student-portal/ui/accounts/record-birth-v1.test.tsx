import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RecordBirthV1 } from '../../../../src/features/student-portal-admin/accounts/record-birth-v1';
import { birthJsonV1, birthMockV1, BIRTH_META_V1 } from '../birth-year/fixtures-v1';

afterEach(cleanup);

function view(mock: ReturnType<typeof birthMockV1>, version?: number) {
  const account = { ...mock.accounts[0]!, ...(version ? { version } : {}) };
  return (
    <StrictMode>
      <RecordBirthV1
        client={mock.client}
        reader={mock.reader}
        account={account}
        scopeVersion={mock.scopeVersion}
      />
    </StrictMode>
  );
}

it('mostra o ano lido e não repete a consulta com a mesma conta', async () => {
  const mock = birthMockV1();
  const ui = render(view(mock));
  await screen.findByText('Nascimento: 2000 · Legado não confirmado');
  const reads = mock.queries.length;
  ui.rerender(view(mock));
  ui.rerender(view(mock));
  ui.rerender(view(mock));
  expect(mock.queries).toHaveLength(reads);
  expect(mock.writes).toHaveLength(0);
});

it('lê de novo quando a conta muda de versão, sem voltar para "…"', async () => {
  const mock = birthMockV1();
  const ui = render(view(mock));
  await screen.findByText('Nascimento: 2000 · Legado não confirmado');
  const reads = mock.queries.length;
  ui.rerender(view(mock, mock.accounts[0]!.version + 1));
  expect(screen.queryByText('Nascimento: …')).toBeNull();
  await waitFor(() => expect(mock.queries.length).toBeGreaterThan(reads));
});

it('falha de rede mostra indisponível; conflito mostra só "—"', async () => {
  const offline = birthMockV1({ query: () => Promise.reject(new TypeError('offline')) });
  render(view(offline));
  await screen.findByText('Nascimento indisponível');
  cleanup();
  const conflict = birthMockV1({
    query: () => Promise.resolve(birthJsonV1({ ...BIRTH_META_V1, state: 'conflict' }, 409)),
  });
  render(view(conflict));
  await screen.findByText('Nascimento: —');
  expect(screen.queryByText('Nascimento indisponível')).toBeNull();
});
