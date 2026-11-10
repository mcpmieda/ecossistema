import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentPhotoPanelV1 } from '../../src/features/student-photos/student-photo-panel-v1';
import { readPhotoCatalogV1 } from '../../src/features/student-photos/catalog-client-v1';
import { photoCatalogStateV1 } from '../../shared/student-photos/catalog-v1';

const spies = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../src/features/student-photos/catalog-client-v1', () => ({
  readPhotoCatalogV1: vi.fn(),
  readCurrentPhotoV1: vi.fn(),
  recoverPhotoWriteV1: vi.fn(),
  announcePhotoChangeV1: vi.fn(),
}));
vi.mock('../../src/features/student-photos/admin-client-v1', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/student-photos/admin-client-v1')>();
  return { ...actual, createPhotoAdminClientV1: () => ({ save: spies.save, preview: vi.fn() }) };
});
vi.mock('../../src/features/student-photos/linked-student-photo-avatar-v1', () => ({
  LinkedStudentPhotoAvatarV1: () => <span role="img" aria-label="Foto do aluno" />,
}));

const subject = { source: 'gradebook' as const, academicYear: 2026, studentIds: [7] };
const uid = '20000000-0000-4000-8000-000000000001';
const revision = '30000000-0000-4000-8000-000000000001';
function catalog(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    state: 'catalog' as const,
    traceId: uid,
    canWrite: true,
    catalog: photoCatalogStateV1.parse({
      version: 1, studentUid: uid, revision, initialized: true, hasPortrait: true, hasAvatar: false,
      pendingRequest: null, pendingKind: null, pendingStage: null, ownPending: false, portalReady: false,
      ...overrides,
    }),
  };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('falha ao abrir: aviso calmo e "Tentar de novo", que some quando a releitura dá certo', async () => {
  const user = userEvent.setup();
  vi.mocked(readPhotoCatalogV1)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(catalog());
  render(<StudentPhotoPanelV1 subject={subject} />);
  expect(await screen.findByText('Não foi possível carregar a foto agora.')).toBeTruthy();
  expect(screen.queryByText(/não foi salva/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull());
  expect(await screen.findByRole('button', { name: 'Trocar foto' })).toBeTruthy();
});

it('depois de salvar com sucesso não aparece "Tentar de novo"', async () => {
  const user = userEvent.setup();
  vi.mocked(readPhotoCatalogV1)
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(catalog({ hasPortrait: false }));
  spies.save.mockImplementationOnce(async (_subject, cmd) => ({
    state: 'committed', requestId: cmd.requestId, revision: cmd.requestId, cleanupPending: false,
  }));
  render(<StudentPhotoPanelV1 subject={subject} />);
  await user.click(await screen.findByRole('button', { name: 'Remover' }));
  await user.click(screen.getByRole('button', { name: 'Remover foto' }));
  await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByText('Processando foto…')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
});
