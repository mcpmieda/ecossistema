import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentPhotoPanelV1 } from '../../src/features/student-photos/student-photo-panel-v1';
import { PhotoAdminClientErrorV1 } from '../../src/features/student-photos/admin-client-v1';
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
  const actual =
    await importOriginal<typeof import('../../src/features/student-photos/admin-client-v1')>();
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
      version: 1,
      studentUid: uid,
      revision,
      initialized: true,
      hasPortrait: true,
      hasAvatar: false,
      pendingRequest: null,
      pendingKind: null,
      pendingStage: null,
      ownPending: false,
      portalReady: false,
      ...overrides,
    }),
  };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('keeps a forbidden initial read neutral instead of claiming an edit failed', async () => {
  vi.mocked(readPhotoCatalogV1).mockRejectedValueOnce(new PhotoAdminClientErrorV1('forbidden'));
  render(<StudentPhotoPanelV1 subject={subject} />);
  await waitFor(() => expect(readPhotoCatalogV1).toHaveBeenCalledOnce());
  expect(screen.queryByText('Sua permissão não permite alterar esta foto.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Adicionar foto' })).toBeNull();
  expect(spies.save).not.toHaveBeenCalled();
});
it('shows an imported portrait as editable without the old synchronization notice', async () => {
  vi.mocked(readPhotoCatalogV1).mockResolvedValueOnce(catalog());
  render(<StudentPhotoPanelV1 subject={subject} />);
  expect(await screen.findByRole('button', { name: 'Trocar foto' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remover' })).toBeTruthy();
  expect(screen.queryByText(/SharePoint/)).toBeNull();
});
it('uses the imported revision for direct removal', async () => {
  const user = userEvent.setup();
  vi.mocked(readPhotoCatalogV1)
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(catalog({ initialized: true, revision, hasPortrait: false }));
  spies.save.mockImplementationOnce(async (_subject, cmd) => ({
    state: 'committed',
    requestId: cmd.requestId,
    revision: cmd.requestId,
    cleanupPending: false,
  }));
  render(<StudentPhotoPanelV1 subject={subject} />);
  await user.click(await screen.findByRole('button', { name: 'Remover' }));
  await user.click(screen.getByRole('button', { name: 'Remover foto' }));
  await waitFor(() => expect(spies.save).toHaveBeenCalledOnce());
  expect(vi.mocked(readPhotoCatalogV1).mock.calls[1]?.[2]).toBe(true);
  expect(spies.save.mock.calls[0]?.[1]).toMatchObject({
    kind: 'remove',
    expectedRevision: revision,
  });
  expect(spies.save.mock.calls[0]?.[2]).toBeNull();
});
it('opens the file picker directly for a student without a photo, then the editor with the choice', async () => {
  const user = userEvent.setup();
  vi.mocked(readPhotoCatalogV1).mockResolvedValue(catalog({ hasPortrait: false }));
  const click = vi.spyOn(HTMLInputElement.prototype, 'click');
  const { container } = render(<StudentPhotoPanelV1 subject={subject} />);
  await user.click(await screen.findByRole('button', { name: 'Adicionar foto' }));
  // No intermediate editor: the browser's own picker (explorer or gallery) is the first thing shown.
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: 'Editar foto do aluno' })).toBeNull();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input.accept).toBe('image/jpeg,image/png,image/webp');
  await user.upload(input, new File(['synthetic'], 'aluno.png', { type: 'image/png' }));
  expect(await screen.findByRole('dialog', { name: 'Editar foto do aluno' })).toBeTruthy();
  expect(vi.mocked(readPhotoCatalogV1).mock.lastCall?.[2]).toBe(true);
  expect(spies.save).not.toHaveBeenCalled();
  click.mockRestore();
});
it('goes straight to the picker when replacing an existing photo, then saves after the crop without a dialog (29/09/2026)', async () => {
  const user = userEvent.setup();
  vi.mocked(readPhotoCatalogV1).mockResolvedValue(catalog());
  const click = vi.spyOn(HTMLInputElement.prototype, 'click');
  render(<StudentPhotoPanelV1 subject={subject} />);
  await user.click(await screen.findByRole('button', { name: 'Trocar foto' }));
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: 'Editar foto do aluno' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Confirmar foto final' })).toBeNull();
  click.mockRestore();
});
