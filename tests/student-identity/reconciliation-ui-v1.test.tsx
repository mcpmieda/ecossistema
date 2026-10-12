import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentReconciliationV1 } from '../../src/features/student-portal-admin/accounts/student-reconciliation-v1';
import { ReportValidationErrorsV1 } from '../../src/features/gradebook/import/student-report-import-v1';
import {
  createReconciliationActivationV1,
  createReconciliationClientV1,
  type PreparedReconciliationV1,
  type ReconciliationClientV1,
} from '../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';

const uid = '12690000-0000-4000-8000-000000000001';
const uid2 = '12690000-0000-4000-8000-000000000005';
const candidateUid = '12690000-0000-4000-8000-000000000006';
const sourceId = '12690000-0000-4000-8000-000000000002';
const sourceId2 = '12690000-0000-4000-8000-000000000007';
const batchId = '12690000-0000-4000-8000-000000000003';
const observationId2 = '12690000-0000-4000-8000-000000000008';
const context = {
  generation: '12690000-0000-4000-8000-000000000004',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const longName = 'S'.repeat(300);
const longSourceName = 'R'.repeat(300);
function deferredV1<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
const prepare: PreparedReconciliationV1 = {
  contractVersion: 1,
  state: 'ready',
  operation: 'prepare',
  context,
  batchId,
  batchState: 'preparing',
  expiresAt: '2099-01-01T00:00:00Z',
  differences: [],
  counts: { rows: 1, linked: 1, pending: 0 },
  credentialsReady: false,
};
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

describe('Relatório e aba Alunos', () => {
  it('mostra pessoa sem conta e pendência sem UID, carregando histórico somente ao abrir', async () => {
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: null,
            sources: [],
            candidates: [],
            history: [],
          };
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [
            {
              kind: 'person',
              studentUid: uid,
              academicStudentId: 1,
              academicYear: 2026,
              name: 'Pessoa Sem Conta',
              relationName: 'Pessoa Sem Conta',
              classId: 7,
              classLabel: '7A',
              version: 1,
              reconciliation: 'without-report',
              portal: 'without-portal',
              accountId: null,
              possibleSamePerson: false,
            },
            {
              kind: 'external',
              id: 'synthetic-pending',
              sourceId,
              batchId,
              name: 'Pessoa Externa',
              classLabel: '7A',
              reason: 'no_match',
              expiresAt: null,
              warning: false,
              sourceRow: 2,
            },
          ],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    await screen.findByText('Pessoa Sem Conta');
    expect(screen.getByText('Pessoa Externa')).toBeTruthy();
    expect(screen.getByText('Sem Portal')).toBeTruthy();
    expect(request.mock.calls.some(([input]) => input.operation === 'detail')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pessoa Sem Conta' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) => input.operation === 'detail' && input.studentUid === uid,
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Acesso ao Portal' })).toBeNull();
  });
  it('lista todos os erros de nascimento como texto, com aluno e turma destacados', () => {
    render(
      <ReportValidationErrorsV1
        errors={[
          {
            sourceRow: 2,
            name: '<img src=x onerror=alert(1)>',
            classLabel: '7A',
            field: 'birthDate',
            reason: 'nascimento ausente.',
          },
          {
            sourceRow: 9,
            name: 'Pessoa Sintética com Nome Longo',
            classLabel: '8B',
            field: 'birthDate',
            reason: 'nascimento inválido.',
          },
        ]}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)> — 7A').tagName).toBe('STRONG');
    expect(screen.getByText('Pessoa Sintética com Nome Longo — 8B').tagName).toBe('STRONG');
    expect(screen.getByText('Linha 9')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
  it.each(['reconciled', 'review-required'] as const)(
    'permite escolher dados de uma única matrícula em estado %s sem preparar outro relatório',
    async (reconciliation) => {
      const request = vi.fn(
        async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
          if (input.operation === 'catalog')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'catalog',
              context,
              classes: [],
              reportClasses: [],
            };
          if (input.operation === 'list')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'list',
              context,
              nextCursor: null,
              items: [
                {
                  kind: 'person',
                  studentUid: uid,
                  academicStudentId: 1,
                  academicYear: 2026,
                  name: 'Nome Sintético do Relatório',
                  relationName: 'Nome Sintético da Relação',
                  classId: 7,
                  classLabel: '7A',
                  version: 2,
                  reconciliation,
                  portal: 'without-portal',
                  accountId: null,
                  possibleSamePerson: false,
                },
              ],
            };
          if (input.operation === 'detail')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'detail',
              context,
              selectedObservationId: reconciliation === 'review-required' ? batchId : uid,
              sources: [
                {
                  id: sourceId,
                  observationId: batchId,
                  name: 'Nome Sintético Corrigido',
                  classLabel: '7A',
                  birthDate: '2013-03-22',
                  filiation1: null,
                  inep: '00123',
                  studentUid: uid,
                  version: 2,
                  decisionId: sourceId,
                  reviewRequired: false,
                },
              ],
              candidates: [],
              history: [],
            };
          if (input.operation === 'select-observation') return prepare;
          if (input.operation === 'stage')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'stage',
              remaining: 0,
              ready: true,
            };
          return { contractVersion: 1, state: 'committed', context, operationId: batchId };
        },
      );
      render(
        <StudentReconciliationV1
          client={{ request }}
          scope={{ kind: 'school', academicYear: 2026 }}
          canWrite
        />,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Nome Sintético do Relatório' }));
      expect(await screen.findByText('Relação: Nome Sintético da Relação')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: 'Usar estes dados' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirmar decisão' }));
      await waitFor(() =>
        expect(request.mock.calls.some(([input]) => input.operation === 'apply')).toBe(true),
      );
      const mutations = request.mock.calls
        .map(([input]) => input)
        .filter((input) => !['catalog', 'list', 'detail'].includes(input.operation));
      expect(mutations.map((input) => input.operation)).toEqual([
        'select-observation',
        'stage',
        'apply',
      ]);
      expect(mutations[0]).toMatchObject({ studentUid: uid, observationId: batchId });
    },
  );
  it('descarta a resposta atrasada da lista anterior quando a busca muda', async () => {
    const firstList = deferredV1<ReconciliationResponseV1>();
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'list' && !input.search)
          return firstList.promise;
        if (input.operation === 'list')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context,
            nextCursor: null,
            items: [
              {
                kind: 'person',
                studentUid: uid2,
                academicStudentId: 2,
                academicYear: 2026,
                name: 'Pessoa Atual',
                relationName: 'Relação Atual',
                classId: 8,
                classLabel: '8B',
                version: 1,
                reconciliation: 'pending',
                portal: 'without-portal',
                accountId: null,
                possibleSamePerson: false,
              },
            ],
          };
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Buscar aluno ou pendência' }), {
      target: { value: 'atual' },
    });
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([current]) => current.operation === 'list' && current.search === 'atual',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Pessoa Atual')).toBeTruthy();
    await act(async () => {
      firstList.resolve({
        contractVersion: 1,
        state: 'ready',
        operation: 'list',
        context,
        nextCursor: null,
        items: [
          {
            kind: 'person',
            studentUid: uid,
            academicStudentId: 1,
            academicYear: 2026,
            name: 'Pessoa Atrasada',
            relationName: 'Relação Atrasada',
            classId: 7,
            classLabel: '7A',
            version: 1,
            reconciliation: 'pending',
            portal: 'without-portal',
            accountId: null,
            possibleSamePerson: false,
          },
        ],
      });
      await firstList.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText('Pessoa Atual')).toBeTruthy();
      expect(screen.queryByText('Pessoa Atrasada')).toBeNull();
    });
  });
  it.each([
    { button: 'Rejeitar', action: 'reject' as const },
    { button: 'Liberar rejeição', action: 'release' as const },
  ])('envia a decisão %s para a pendência selecionada', async ({ button, action }) => {
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'list')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context,
            nextCursor: null,
            items: [
              {
                kind: 'person',
                studentUid: uid,
                academicStudentId: 1,
                academicYear: 2026,
                name: 'Pessoa para Decisão',
                relationName: 'Pessoa para Decisão',
                classId: 7,
                classLabel: '7A',
                version: 2,
                reconciliation: 'pending',
                portal: 'without-portal',
                accountId: null,
                possibleSamePerson: false,
              },
            ],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: null,
            sources: [
              {
                id: sourceId,
                observationId: batchId,
                name: 'Registro Externo',
                classLabel: '7A',
                birthDate: '2013-03-22',
                filiation1: null,
                inep: null,
                studentUid: null,
                version: 4,
                decisionId: null,
                reviewRequired: false,
              },
            ],
            candidates: [{ studentUid: candidateUid, name: 'Aluno da Relação', classLabel: '7A' }],
            history: [],
          };
        if (input.operation === 'resolve')
          return {
            contractVersion: 1,
            state: 'committed',
            context,
            operationId: '12690000-0000-4000-8000-000000000021',
          };
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Pessoa para Decisão' }));
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Aluno da Relação para Registro Externo' }),
      { target: { value: candidateUid } },
    );
    fireEvent.click(screen.getByRole('button', { name: button }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.operation === 'resolve' &&
            input.action === action &&
            input.studentUid === candidateUid,
        ),
      ).toBe(true),
    );
    expect(
      request.mock.calls.find(([input]) => input.operation === 'resolve')?.[0],
    ).toMatchObject({
      sourceId,
      studentUid: candidateUid,
      action,
      expectedLinkVersion: 4,
      revertsDecisionId: null,
    });
  });
  it('envia confirmação de vínculo e volta para a lista quando o CAS fica obsoleto', async () => {
    const resolvePayloads: ReconciliationRequestV1[] = [];
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'list')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context,
            nextCursor: null,
            items: [
              {
                kind: 'person',
                studentUid: uid,
                academicStudentId: 1,
                academicYear: 2026,
                name: 'Pessoa em Revisão',
                relationName: 'Pessoa em Revisão',
                classId: 7,
                classLabel: '7A',
                version: 3,
                reconciliation: 'review-required',
                portal: 'without-portal',
                accountId: null,
                possibleSamePerson: false,
              },
            ],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: batchId,
            sources: [
              {
                id: sourceId,
                observationId: batchId,
                name: 'Registro Revisado',
                classLabel: '7A',
                birthDate: '2013-03-22',
                filiation1: null,
                inep: null,
                studentUid: uid,
                version: 7,
                decisionId: sourceId,
                reviewRequired: true,
              },
            ],
            candidates: [],
            history: [],
          };
        if (input.operation === 'resolve') {
          resolvePayloads.push(structuredClone(input));
          return { contractVersion: 1, state: 'conflict' };
        }
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Pessoa em Revisão' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar vínculo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) => input.operation === 'resolve' && input.action === 'confirm',
        ),
      ).toBe(true),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Dados alterados. Confira novamente.',
    );
    expect(resolvePayloads).toEqual([
      expect.objectContaining({
        operation: 'resolve',
        action: 'confirm',
        sourceId,
        studentUid: uid,
        expectedLinkVersion: 7,
        revertsDecisionId: null,
      }),
    ]);
    expect(screen.queryByRole('button', { name: 'Voltar aos alunos' })).toBeNull();
  });
  it('repete a mesma resolução depois de uma resposta perdida sem trocar o payload', async () => {
    let resolves = 0;
    const resolvePayloads: ReconciliationRequestV1[] = [];
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'list')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context,
            nextCursor: null,
            items: [
              {
                kind: 'person',
                studentUid: uid,
                academicStudentId: 1,
                academicYear: 2026,
                name: 'Pessoa com Retry',
                relationName: 'Pessoa com Retry',
                classId: 7,
                classLabel: '7A',
                version: 2,
                reconciliation: 'pending',
                portal: 'without-portal',
                accountId: null,
                possibleSamePerson: false,
              },
            ],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: null,
            sources: [
              {
                id: sourceId,
                observationId: batchId,
                name: 'Registro para Retry',
                classLabel: '7A',
                birthDate: '2013-03-22',
                filiation1: null,
                inep: null,
                studentUid: null,
                version: 3,
                decisionId: null,
                reviewRequired: false,
              },
            ],
            candidates: [{ studentUid: candidateUid, name: 'Aluno Retry', classLabel: '7A' }],
            history: [],
          };
        if (input.operation === 'resolve') {
          resolvePayloads.push(structuredClone(input));
          if (++resolves === 1) throw new Error('Resposta perdida');
        }
        if (input.operation === 'resolve')
          return {
            contractVersion: 1,
            state: 'committed',
            context,
            operationId: '12690000-0000-4000-8000-000000000022',
          };
        return {
          contractVersion: 1,
          state: 'ready',
          operation: 'list',
          context,
          nextCursor: null,
          items: [],
        };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Pessoa com Retry' }));
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Aluno da Relação para Registro para Retry' }),
      { target: { value: candidateUid } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Resposta não confirmada. Tente novamente.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Repetir mesma solicitação' }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([input]) => input.operation === 'resolve'),
      ).toHaveLength(2),
    );
    expect(resolvePayloads).toHaveLength(2);
    expect(resolvePayloads[0]).toEqual(resolvePayloads[1]);
    expect(resolvePayloads[0]).toMatchObject({
      operation: 'resolve',
      action: 'associate',
      sourceId,
      studentUid: candidateUid,
      expectedLinkVersion: 3,
      revertsDecisionId: null,
    });
  });
  it('mantém nomes longos e permite escolher outra observação inteira já ligada da mesma pessoa', async () => {
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context,
            classes: [],
            reportClasses: [],
          };
        if (input.operation === 'list')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context,
            nextCursor: null,
            items: [
              {
                kind: 'person',
                studentUid: uid,
                academicStudentId: 1,
                academicYear: 2026,
                name: longName,
                relationName: 'Relação ' + longName,
                classId: 7,
                classLabel: '7A',
                version: 2,
                reconciliation: 'review-required',
                portal: 'without-portal',
                accountId: null,
                possibleSamePerson: true,
              },
            ],
          };
        if (input.operation === 'detail')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context,
            selectedObservationId: batchId,
            sources: [
              {
                id: sourceId,
                observationId: batchId,
                name: longSourceName,
                classLabel: '7A',
                birthDate: '2013-03-22',
                filiation1: null,
                inep: null,
                studentUid: uid,
                version: 2,
                decisionId: sourceId,
                reviewRequired: false,
              },
              {
                id: sourceId2,
                observationId: observationId2,
                name: `${longSourceName} B`,
                classLabel: '7B',
                birthDate: '2013-03-22',
                filiation1: null,
                inep: null,
                studentUid: uid,
                version: 2,
                decisionId: sourceId2,
                reviewRequired: false,
              },
            ],
            candidates: [],
            history: [],
          };
        if (input.operation === 'select-observation') return prepare;
        if (input.operation === 'stage')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'stage',
            remaining: 0,
            ready: true,
          };
        return { contractVersion: 1, state: 'committed', context, operationId: batchId };
      },
    );
    render(
      <StudentReconciliationV1
        client={{ request }}
        scope={{ kind: 'school', academicYear: 2026 }}
        canWrite
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: longName }));
    expect((await screen.findAllByText(longName)).length).toBeGreaterThan(0);
    expect(
      screen.getByText((_, element) => element?.textContent === `${longSourceName} — 7A`),
    ).toBeTruthy();
    expect(
      screen.getByText((_, element) => element?.textContent === `${longSourceName} B — 7B`),
    ).toBeTruthy();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Usar estes dados' }))[1]!);
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([input]) =>
            input.operation === 'select-observation' &&
            input.studentUid === uid &&
            input.observationId === observationId2,
        ),
      ).toBe(true),
    );
  });
  it('prepara todas as credenciais antes da única ativação e repete a mesma chave após resposta perdida', async () => {
    let stages = 0;
    let applies = 0;
    const request = vi.fn(
      async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'stage')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'stage',
            ready: ++stages === 2,
            remaining: stages === 1 ? 1 : 0,
          };
        if (input.operation === 'apply' && ++applies === 1) throw new Error('Resposta perdida');
        return {
          contractVersion: 1,
          state: 'committed',
          context,
          operationId: 'synthetic-operation',
        };
      },
    );
    const activate = createReconciliationActivationV1(prepare, false);
    await expect(activate({ request }, vi.fn())).rejects.toThrow('Resposta perdida');
    await expect(activate({ request }, vi.fn())).resolves.toMatchObject({ state: 'committed' });
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      'stage',
      'stage',
      'apply',
      'apply',
    ]);
    expect(request.mock.calls[2]![0]).toEqual(request.mock.calls[3]![0]);
  });
  it('preparação incompleta ou expirada nunca chama apply', async () => {
    const request = vi.fn(async (): Promise<ReconciliationResponseV1> => ({
      contractVersion: 1,
      state: 'expired',
    }));
    const activate = createReconciliationActivationV1(prepare, true);
    expect(await activate({ request } satisfies ReconciliationClientV1, vi.fn())).toMatchObject({
      state: 'expired',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('transporte mantém bytes e chave idempotente na repetição técnica e exige no-store', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error('Resposta perdida');
      return new Response(
        JSON.stringify({ contractVersion: 1, state: 'committed', context, operationId: batchId }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    });
    const client = createReconciliationClientV1({ fetch: fetcher });
    await client.request({
      contractVersion: 1,
      academicYear: 2026,
      operation: 'apply',
      generation: context.generation,
      expectedRevision: 1,
      batchId,
      idempotencyKey: uid,
      confirmDifferences: true,
    });
    expect(bodies[0]).toBe(bodies[1]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });
});
