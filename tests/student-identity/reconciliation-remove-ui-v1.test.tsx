import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentReconciliationV1 } from '../../src/features/student-portal-admin/accounts/student-reconciliation-v1';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';

const uid = '20261120-0000-4000-8000-000000000001';
const accountId = '20261120-0000-4000-8000-000000000002';
const context = {
  generation: '20261120-0000-4000-8000-000000000003',
  revision: 4,
  nameSource: 'relation' as const,
  relationAvailable: true,
};
const scope = { kind: 'school' as const, academicYear: 2026 as const };

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

/** A Conciliação with one synthetic student; `removable` is what the server says of it. */
function serverV1(removable: boolean | undefined) {
  let removed = false;
  return vi.fn(async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
    const base = { contractVersion: 1 as const, state: 'ready' as const, context };
    if (input.operation === 'catalog')
      return { ...base, operation: 'catalog', classes: [], reportClasses: [] };
    if (input.operation === 'detail')
      return {
        ...base,
        operation: 'detail',
        selectedObservationId: null,
        sources: [],
        candidates: [],
        history: [],
        ...(removable === undefined ? {} : { removable }),
      };
    if (input.operation === 'remove-student') {
      removed = true;
      return {
        contractVersion: 1,
        state: 'committed',
        context: { ...context, revision: 5 },
        operationId: '20261120-0000-4000-8000-000000000004',
        accountClosed: true,
      };
    }
    if (input.operation !== 'list') throw new Error(`unexpected ${input.operation}`);
    return {
      ...base,
      operation: 'list',
      nextCursor: null,
      items: removed
        ? []
        : [
            {
              kind: 'person',
              studentUid: uid,
              academicStudentId: 1179,
              academicYear: 2026,
              name: 'SYNTHETIC MISTAKE',
              relationName: 'SYNTHETIC MISTAKE',
              classId: 1,
              classLabel: '6A',
              version: 1,
              reconciliation: 'without-report',
              portal: 'with-portal',
              accountId,
              possibleSamePerson: false,
            },
          ],
    };
  });
}

it('exclui um aluno lançado por engano, com confirmação, e volta à lista', async () => {
  const request = serverV1(true);
  const user = userEvent.setup();
  render(<StudentReconciliationV1 client={{ request }} scope={scope} canWrite={true} />);
  await user.click(await screen.findByRole('button', { name: 'SYNTHETIC MISTAKE' }));
  await user.click(await screen.findByRole('button', { name: 'Excluir aluno lançado por engano' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('SYNTHETIC MISTAKE')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
  expect(await screen.findByText('Aluno excluído.')).toBeTruthy();
  const removal = request.mock.calls.find(([input]) => input.operation === 'remove-student')![0];
  expect(removal).toMatchObject({
    operation: 'remove-student',
    studentUid: uid,
    accountId,
    generation: context.generation,
    expectedRevision: context.revision,
  });
  expect(screen.queryByRole('button', { name: 'SYNTHETIC MISTAKE' })).toBeNull();
});

it('não oferece a exclusão a quem tem dados, nem sem permissão de escrita', async () => {
  const user = userEvent.setup();
  render(
    <StudentReconciliationV1 client={{ request: serverV1(false) }} scope={scope} canWrite={true} />,
  );
  await user.click(await screen.findByRole('button', { name: 'SYNTHETIC MISTAKE' }));
  await screen.findByRole('button', { name: 'Voltar aos alunos' });
  expect(screen.queryByRole('button', { name: 'Excluir aluno lançado por engano' })).toBeNull();
  cleanup();
  render(
    <StudentReconciliationV1 client={{ request: serverV1(true) }} scope={scope} canWrite={false} />,
  );
  await user.click(await screen.findByRole('button', { name: 'SYNTHETIC MISTAKE' }));
  await screen.findByRole('button', { name: 'Voltar aos alunos' });
  expect(screen.queryByRole('button', { name: 'Excluir aluno lançado por engano' })).toBeNull();
});
